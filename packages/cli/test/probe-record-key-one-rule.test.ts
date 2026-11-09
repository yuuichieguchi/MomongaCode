import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProbeRecordKey, ResolvedModelTarget, UserModels } from '@momonga/config';
import { loadUserSettings, probeRecordKeyOf } from '@momonga/config';
import type { EntryIo } from '@momonga/foundation';
import { momongaPaths } from '@momonga/foundation';
import { endpointRecordFileName } from '@momonga/gateway';
import { REAL_PROCESS_TEST_TIMEOUT_MS } from '@momonga/testkit';
import type { DaemonEntries } from '../src/daemon/entries.ts';
import { liveSettingsFor } from '../src/eval/context-host.ts';
import { nodePorts } from '../src/node-ports.ts';
import type { CliPorts } from '../src/ports.ts';
import { buildProgram } from '../src/program.ts';
import type { UpdatePorts } from '../src/update/ports.ts';
import { GITHUB_ENDPOINTS } from '../src/update/source.ts';
import { nodePolicyVerifyHost } from '../src/verify/host.ts';
import { OLLAMA_MODEL, startFakeOllama } from '../../gateway/test/ollama-support.ts';

vi.mock('@momonga/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@momonga/config')>();
  const taggedModel = (model: string): string => (model.includes(':') ? model : `${model}:latest`);
  return {
    ...actual,
    probeRecordKeyOf: (name: string, target: ResolvedModelTarget): ProbeRecordKey | undefined => {
      const key = actual.probeRecordKeyOf(name, target);
      return key?.kind === 'endpoint' ? { kind: 'endpoint', key: { ...key.key, model: taggedModel(key.key.model) } } : key;
    },
  };
});

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const freshDir = (prefix: string): string => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

const runCli = async (home: string, args: readonly string[]): Promise<{ codes: number[]; stdout: string; stderr: string }> => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const codes: number[] = [];
  const ports: CliPorts = {
    ...nodePorts('9.9.9'),
    home,
    cwd: home,
    env: { PATH: '/usr/bin:/bin', HOME: home },
    terminal: undefined,
    stdout: { write: (text) => void stdout.push(text) },
    stderr: { write: (text) => void stderr.push(text) },
  };
  const entry = async (): Promise<number> => 0;
  const entries: DaemonEntries = { supervise: entry, gateway: entry, runtime: entry };
  const program = buildProgram({
    ports,
    policyVerify: () => nodePolicyVerifyHost(ports, { executables: path.join(home, 'cache', 'executables') }),
    entries,
    update: () => ({ ports: { self: { kind: 'script', execPath: '/node', script: '/main.js' } } as unknown as UpdatePorts, build: { repo: undefined, teamId: undefined, publicKey: undefined }, endpoints: GITHUB_ENDPOINTS, checkIntervalMs: 1 }),
    interrupt: new AbortController().signal,
    entryIo: (entryArgs) => ({ argv: [...entryArgs] }) as unknown as EntryIo,
    complete: (code) => void codes.push(code),
  });
  program.exitOverride();
  await program.parseAsync([...args], { from: 'user' });
  return { codes, stdout: stdout.join(''), stderr: stderr.join('') };
};

const endpointKeyFor = (name: string, target: ResolvedModelTarget) => {
  const key = probeRecordKeyOf(name, target);
  if (key?.kind !== 'endpoint') throw new Error(`the target ${name} has no endpoint probe record key`);
  return key.key;
};

const writeOllamaSettings = (home: string, baseUrl: string): void => {
  const root = path.join(home, '.momonga');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(root, 'settings.json'),
    JSON.stringify({ models: { targets: { local: { adapter: 'ollama', model: OLLAMA_MODEL, baseUrl, capabilities: { contextWindow: 12288, maxOutputTokens: 2048 } } } } }),
    { mode: 0o600 },
  );
};

describe('the probe command writes the record under the key probeRecordKeyOf gives (W-5)', { timeout: REAL_PROCESS_TEST_TIMEOUT_MS }, () => {
  it('writes an ollama target given with a trailing slash under the key the gateway and the eval host read', async () => {
    const fake = await startFakeOllama({ cacheProbe: 'none' });
    const home = freshDir('mm-home-');
    writeOllamaSettings(home, `${fake.origin}/`);
    const { settings } = await loadUserSettings({ home });
    const resolved = settings.models.targets['local'];
    if (resolved === undefined) throw new Error('the settings resolved no local target');
    const key = endpointKeyFor('local', resolved);

    const result = await runCli(home, ['gateway', 'probe', 'local']);

    expect(result.codes).toEqual([0]);
    const probeDir = momongaPaths(home, process.platform, {}).probe;
    expect(fs.readdirSync(probeDir)).toContain(endpointRecordFileName(key));
  });
});

const capabilities = {
  contextWindow: 8192,
  maxOutputTokens: 1024,
  structuredOutput: 'none',
  streaming: true,
  stopSequences: true,
  imageInput: false,
  parallelToolCalls: false,
  schemaDialect: 'json-schema-2020-12',
  tokenCounting: 'estimated',
  usageReported: true,
  source: 'config',
  maxConcurrency: 4,
} as const;

const remote = { billing: 'metered', capabilities, maxConcurrency: 4, admissionTimeoutMs: 30000 } as const;
const declaredCapabilities = { contextWindow: 8192, maxOutputTokens: 1024 };

const hostModels = (): UserModels =>
  ({
    declared: {
      aliases: { default: ['tcp', 'socket'] },
      targets: {
        tcp: { adapter: 'ollama', model: 'qwen3', baseUrl: 'http://127.0.0.1:11434/', capabilities: declaredCapabilities },
        socket: { adapter: 'ollama', model: 'qwen3', socketPath: '/s/ollama.sock', capabilities: declaredCapabilities },
      },
    },
    resolved: {
      aliases: { default: ['tcp', 'socket'] },
      targets: {
        tcp: { ...remote, adapter: 'ollama', model: 'qwen3', baseUrl: 'http://127.0.0.1:11434/' },
        socket: { ...remote, adapter: 'ollama', model: 'qwen3', socketPath: '/s/ollama.sock' },
      },
      roles: {},
    },
  }) as unknown as UserModels;

describe('the eval host carries the key probeRecordKeyOf gives instead of rebuilding it (W-5)', () => {
  it('carries the record key of a TCP target with a trailing slash and of a socket target', () => {
    const models = hostModels();
    const expected = ['tcp', 'socket'].map((name) => endpointKeyFor(name, models.resolved.targets[name] as ResolvedModelTarget));
    expect(expected).toEqual([
      { endpoint: 'http://127.0.0.1:11434', model: 'qwen3:latest' },
      { endpoint: 'unix:/s/ollama.sock', model: 'qwen3:latest' },
    ]);

    expect(liveSettingsFor(models, ['default']).endpointProbes).toEqual(expected);
  });
});

const sourceOf = (relative: string): string => fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', relative), 'utf8');

const HAND_BUILT_UPSTREAM = /kind:\s*'unix',\s*socketPath:\s*target\.socketPath|kind:\s*'tcp',\s*baseUrl:\s*target\.baseUrl/;

describe('the upstream of a target comes from upstreamEndpointOf, never a hand-built copy (W-5)', () => {
  it.for(['cli/src/commands/gateway.ts', 'gateway/src/process.ts'])('%s builds no upstream from socketPath or baseUrl by hand', (file) => {
    expect(sourceOf(file)).not.toMatch(HAND_BUILT_UPSTREAM);
  });
});
