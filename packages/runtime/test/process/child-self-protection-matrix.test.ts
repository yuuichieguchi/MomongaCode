import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { momongaPaths, nodeFileSystem, nodeFileSystemSync, personCapabilityOf, ruleEnforcementOf, systemRandom } from '@momonga/foundation';
import type { ChildLaunch } from '@momonga/foundation';
import { createGroupSpawn } from '../../../gateway/src/managed/fm-processes.ts';
import { createStdioTransport } from '@momonga/mcp';
import { DEFAULT_BWRAP_PATH, createUnsandboxed } from '@momonga/sandbox';
import type { Sandbox, SandboxPolicy, SandboxSetting } from '@momonga/sandbox';
import type { HooksSettings } from '@momonga/protocol';
import { createPolicyFilesystem, createToolHooks, nodeShellHost } from '@momonga/tools';
import { REAL_PROCESS_TEST_TIMEOUT_MS, TEST_CHILD_UNPROTECTED, createTempDir, killGroupsForCleanup, pollUntil, removeTempDir, testKernelLock, testProcessInspector } from '@momonga/testkit';
import { hostNoneSandboxLaunch } from '../../src/process/host-none-sandbox-launch.ts';
import { createSandboxOf, placeholderJournalDirectoryOf } from '../../src/process/sandbox-of.ts';
import { toolSandboxPolicyOf } from '../../src/process/tool-policy.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const REPORT_BOUND_MS = 20_000;
const HOST_PATH = '/usr/bin:/bin';

const PLATFORM_SANDBOX: Partial<Record<NodeJS.Platform, SandboxSetting>> = {
  darwin: 'seatbelt',
  ...(fs.existsSync(DEFAULT_BWRAP_PATH) ? { linux: 'bubblewrap' as const } : {}),
};
const platformSandbox = PLATFORM_SANDBOX[process.platform];
const SETTINGS: readonly SandboxSetting[] = platformSandbox === undefined ? [] : [platformSandbox, 'none'];

const PROBE = `
const fs = require('node:fs');
const net = require('node:net');
const [file, socket, report] = process.argv.slice(2);
const outcome = {};
try { outcome.read = fs.readFileSync(file, 'utf8'); } catch (error) { outcome.read = error.code; }
const done = () => fs.writeFileSync(report, JSON.stringify(outcome));
const connection = net.connect(socket);
connection.on('connect', () => { outcome.connect = 'connected'; connection.destroy(); done(); });
connection.on('error', (error) => { outcome.connect = error.code; done(); });
`;

type Outcome = { read: string; connect: string };

type Home = {
  home: string;
  work: string;
  capability: string;
  socket: string;
  connections(): number;
  probeArgv(report: string): string[];
  probeCommand(report: string): string;
};

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const productHome = async (): Promise<Home> => {
  const home = createTempDir({ asHome: true });
  cleanups.push(() => removeTempDir(home));
  const work = createTempDir();
  cleanups.push(() => removeTempDir(work));
  const capability = await personCapabilityOf({ files: nodeFileSystem, random: systemRandom, lock: testKernelLock() }, home);
  const socketDirectory = path.join(home, '.momonga', 'run');
  fs.mkdirSync(socketDirectory, { recursive: true });
  const socket = path.join(socketDirectory, 'r.sock');
  let connections = 0;
  const server = net.createServer((connection) => {
    connections += 1;
    connection.end();
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const probe = path.join(work, 'probe.js');
  fs.writeFileSync(probe, PROBE);
  const probeArgv = (report: string): string[] => [process.execPath, probe, path.join(home, '.momonga', 'person-capability'), socket, report];
  return {
    home,
    work,
    capability,
    socket,
    connections: () => connections,
    probeArgv,
    probeCommand: (report) => probeArgv(report).map((part) => `'${part}'`).join(' '),
  };
};

const reportOf = async (report: string): Promise<Outcome> => {
  await pollUntil(() => fs.existsSync(report), { description: `the report ${report} of the probe`, boundMs: REPORT_BOUND_MS });
  const parsed: unknown = JSON.parse(fs.readFileSync(report, 'utf8'));
  if (typeof parsed !== 'object' || parsed === null || !('read' in parsed) || !('connect' in parsed)) throw new Error(`the probe wrote no outcome: ${JSON.stringify(parsed)}`);
  return { read: String(parsed.read), connect: String(parsed.connect) };
};

type Composition = { launch: ChildLaunch; sandbox: Sandbox; policy: SandboxPolicy };

const compositionOf = async (setting: SandboxSetting, place: Home): Promise<Composition> => {
  const signal = new AbortController().signal;
  const paths = momongaPaths(place.home, process.platform, {});
  fs.mkdirSync(paths.tmp.spawn, { recursive: true });
  const launch = await hostNoneSandboxLaunch({ home: place.home, platform: process.platform, env: {} }, signal);
  const sandbox = await createSandboxOf({
    platform: process.platform,
    paths,
    env: { PATH: HOST_PATH },
    shellHost: nodeShellHost(),
    kernelLock: testKernelLock(),
    journalDirectory: placeholderJournalDirectoryOf(paths),
    noneProtection: launch.protection,
    warn: () => undefined,
  })(setting, signal);
  const policy = await toolSandboxPolicyOf(
    { paths, home: place.home, fs: createPolicyFilesystem(), ruleEnforcement: ruleEnforcementOf(sandbox.kind) },
    { roots: [place.work], tmpDir: undefined, rules: [], gitConfigFiles: [], readableDirectories: [] },
    signal,
  );
  return { launch, sandbox, policy };
};

const drained = async (stream: AsyncIterable<Uint8Array>): Promise<void> => {
  for await (const _chunk of stream);
};

const spawnedThrough = async (sandbox: Pick<Sandbox, 'spawn'>, policy: SandboxPolicy, place: Home, report: string): Promise<void> => {
  const child = await sandbox.spawn({ argv: place.probeArgv(report), cwd: place.work, env: { PATH: HOST_PATH } }, policy, new AbortController().signal);
  cleanups.push(() => killGroupsForCleanup([child.pgid]));
  await Promise.all([drained(child.stdout), drained(child.stderr), child.exited]);
};

type ChildKind = 'tool command' | 'stdio MCP server' | 'hook' | '! command' | 'managed model server';

const runChild: Record<ChildKind, (composition: Composition, place: Home, report: string) => Promise<void>> = {
  'tool command': ({ sandbox, policy }, place, report) => spawnedThrough(sandbox, policy, place, report),
  '! command': ({ launch, policy }, place, report) => spawnedThrough(createUnsandboxed({ killGraceMs: 200, protection: launch.protection, platform: process.platform }), policy, place, report),
  hook: async ({ sandbox, policy }, place, report) => {
    const markerDir = path.join(place.work, 'hook-markers');
    fs.mkdirSync(markerDir, { recursive: true });
    const hooks: HooksSettings = { PreToolUse: [{ hooks: [{ type: 'command', command: place.probeCommand(report) }] }] };
    await createToolHooks({
      inspector: testProcessInspector(),
      hooks,
      sandbox,
      sandboxPolicy: policy,
      env: { PATH: HOST_PATH },
      shellHost: nodeShellHost(),
      cwd: place.work,
      projectDir: place.work,
      markerDir,
      runId: 'run-1',
      session: { id: 's1', permissionMode: 'manual' },
      clock: { now: () => Date.now() },
      signal: new AbortController().signal,
      deadlineAt: Date.now() + REAL_PROCESS_TEST_TIMEOUT_MS,
      drainIdleMs: 1000,
      started: () => undefined,
      report: () => undefined,
    }).preToolUse({ callId: 'c1', toolName: 'Bash', input: { command: 'ls' } });
  },
  'stdio MCP server': async ({ launch }, place, report) => {
    const [command, ...args] = place.probeArgv(report);
    const transport = createStdioTransport({
      name: 'probe',
      config: { command: command ?? process.execPath, args },
      projectDir: place.work,
      baseEnv: { PATH: HOST_PATH },
      files: nodeFileSystem,
      launch: { protection: launch.protection, commandOf: (argv) => launch.commandOf(argv, []) },
    });
    cleanups.push(() => transport.close(0));
    await transport.start();
  },
  'managed model server': async ({ launch }, place, report) => {
    const markerDirectory = path.join(place.work, 'server-markers');
    fs.mkdirSync(markerDirectory, { recursive: true });
    const command = launch.commandOf(place.probeArgv(report), []);
    const child = await createGroupSpawn({ env: { PATH: HOST_PATH }, markerDirectory, onWarning: () => undefined, inspector: testProcessInspector(), random: systemRandom, fileSystem: nodeFileSystemSync })(command.file, command.args, launch.protection);
    cleanups.push(async () => {
      await child.kill('SIGKILL');
    });
  },
};

const KINDS = Object.keys(runChild) as ChildKind[];

describe.runIf(SETTINGS.length > 0)("a child of every kind under every sandbox setting cannot read the product's control socket or the capability of the person (macOS seatbelt; Linux bubblewrap in the container; Windows is not claimed by the threat model)", () => {
  it('a child started unprotected reaches both, so the refusals below are the protection and not the test', async () => {
    const place = await productHome();
    const report = path.join(place.work, 'unprotected.json');
    await spawnedThrough(createUnsandboxed({ killGraceMs: 200, protection: TEST_CHILD_UNPROTECTED, platform: process.platform }), { ...(await compositionOf('none', place)).policy }, place, report);
    expect(await reportOf(report)).toEqual({ read: place.capability, connect: 'connected' });
  });

  for (const setting of SETTINGS) {
    for (const kind of KINDS) {
      it(`a ${kind} under sandbox ${setting}`, async () => {
        const place = await productHome();
        const report = path.join(place.work, 'report.json');
        await runChild[kind](await compositionOf(setting, place), place, report);
        const outcome = await reportOf(report);
        expect(outcome.read).not.toBe(place.capability);
        expect(outcome.read).toMatch(/^(EPERM|EACCES|ENOENT)$/);
        expect(outcome.connect).toMatch(/^(EPERM|EACCES|ENOENT|ECONNREFUSED)$/);
        expect(place.connections()).toBe(0);
      });
    }
  }
});
