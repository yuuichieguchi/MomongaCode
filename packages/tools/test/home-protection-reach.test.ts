import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_FILE_RULES, EMPTY_PROTECTED_SET, momongaLayout } from '@momonga/foundation';
import type { ChildProtection } from '@momonga/foundation';
import type { HooksSettings } from '@momonga/protocol';
import { DEFAULT_BWRAP_PATH, childProtectionFor, createUnsandboxed } from '@momonga/sandbox';
import { createToolHooks, nodeShellHost } from '@momonga/tools';
import { REAL_PROCESS_TEST_TIMEOUT_MS, TEST_CHILD_UNPROTECTED, createTempDir, testProcessInspector } from '@momonga/testkit';
import { makeBuiltins, resultOf } from './builtins/fixtures.ts';

const quote = (text: string): string => `'${text.replaceAll("'", "'\\''")}'`;

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const SHORT_TEMP_PARENT = '/tmp';
const PROTECTING_HOST = (process.platform === 'darwin' && fs.existsSync('/usr/bin/sandbox-exec')) || (process.platform === 'linux' && fs.existsSync(DEFAULT_BWRAP_PATH));

type ControlSocket = { socketPath: string; home: string; connections: () => number; close: () => Promise<void> };

const roots: string[] = [];
const sockets: ControlSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) await socket.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const productControlSocket = async (): Promise<ControlSocket> => {
  const home = createTempDir({ parent: SHORT_TEMP_PARENT });
  roots.push(home);
  const layout = momongaLayout(home, process.platform, {});
  fs.mkdirSync(layout.root, { recursive: true, mode: 0o700 });
  const socketPath = path.join(layout.root, 'c.sock');
  let connections = 0;
  const server = net.createServer((connection) => {
    connections += 1;
    connection.end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => resolve());
  });
  const control: ControlSocket = { socketPath, home, connections: () => connections, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
  sockets.push(control);
  return control;
};

const noneProtectionOf = (home: string): ChildProtection => childProtectionFor({ sandbox: 'none', home, platform: process.platform, env: {}, bubblewrap: process.platform === 'linux' });

const connectCommand = (socketPath: string): string =>
  `${quote(process.execPath)} -e ${quote(`require('net').connect(process.argv[1]).on('connect', () => process.exit(0)).on('error', () => process.exit(1))`)} ${quote(socketPath)}; echo "connect ended with $?"`;

const bashReaches = async (protection: ChildProtection, socketPath: string): Promise<string> => {
  const tools = await makeBuiltins({ sandbox: createUnsandboxed({ protection, platform: process.platform, killGraceMs: 200 }) });
  return resultOf(await tools.run('Bash', { command: connectCommand(socketPath) }, { env: { PATH: '/usr/bin:/bin' } }, 'allow_once')).output;
};

const hookReaches = async (protection: ChildProtection, socketPath: string): Promise<void> => {
  const dir = createTempDir();
  roots.push(dir);
  const markerDir = path.join(dir, 'markers');
  fs.mkdirSync(markerDir);
  const hooks: HooksSettings = { PreToolUse: [{ hooks: [{ type: 'command', command: connectCommand(socketPath) }] }] };
  await createToolHooks({
    inspector: testProcessInspector(),
    hooks,
    sandbox: createUnsandboxed({ protection, platform: process.platform, killGraceMs: 200 }),
    sandboxPolicy: { writableRoots: [dir], writeDenied: [], writeDeniedLiterals: [], readDenied: [], network: 'deny', fileRules: EMPTY_FILE_RULES, protectedSet: EMPTY_PROTECTED_SET },
    env: { PATH: '/usr/bin:/bin' },
    shellHost: nodeShellHost(),
    cwd: dir,
    projectDir: dir,
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
};

describe.runIf(PROTECTING_HOST)("a process a tool starts under sandbox none cannot reach the product's control socket (macOS seatbelt, Linux bubblewrap)", () => {
  it('reaches the socket when it runs unprotected, so the refusal below is the protection and not the test', async () => {
    const control = await productControlSocket();
    await bashReaches(TEST_CHILD_UNPROTECTED, control.socketPath);
    expect(control.connections()).toBe(1);
  });

  it('Bash under sandbox none is refused the socket in the home', async () => {
    const control = await productControlSocket();
    const output = await bashReaches(noneProtectionOf(control.home), control.socketPath);
    expect(output).toContain('connect ended with');
    expect(control.connections()).toBe(0);
  });

  it('a hook command under sandbox none is refused the socket in the home', async () => {
    const control = await productControlSocket();
    await hookReaches(noneProtectionOf(control.home), control.socketPath);
    expect(control.connections()).toBe(0);
  });
});
