import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_FILE_RULES, EMPTY_PROTECTED_SET, findHolders } from '@momonga/foundation';
import { createUnsandboxed } from '@momonga/sandbox';
import type { Sandbox, SandboxPolicy } from '@momonga/sandbox';
import * as tools from '@momonga/tools';
import { nodeShellHost } from '@momonga/tools';
import { REAL_PROCESS_TEST_TIMEOUT_MS } from '@momonga/testkit';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

type CommandResult =
  | { kind: 'exited'; exitCode: number; stdout: string; stderr: string; durationMs: number }
  | { kind: 'signaled'; signal: string; stdout: string; stderr: string; durationMs: number }
  | { kind: 'timed_out'; stdout: string; stderr: string; durationMs: number }
  | { kind: 'cancelled'; durationMs: number }
  | { kind: 'spawn_error'; message: string; durationMs: number };

type RunSandboxedCommand = (request: Record<string, unknown>) => Promise<CommandResult>;

const runSandboxedCommand: RunSandboxedCommand = (request) => {
  const found = (tools as Record<string, unknown>)['runSandboxedCommand'];
  if (typeof found !== 'function') throw new Error('@momonga/tools does not export runSandboxedCommand');
  return (found as RunSandboxedCommand)(request);
};

let dir = '';

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mm-sandboxed-')));
  fs.mkdirSync(path.join(dir, 'markers'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const policy = (): SandboxPolicy => ({
  writableRoots: [dir],
  writeDenied: [],
  writeDeniedLiterals: [],
  readDenied: [],
  network: 'deny',
  fileRules: EMPTY_FILE_RULES,
  protectedSet: EMPTY_PROTECTED_SET,
});

const spawned: { argv: readonly string[]; policy: SandboxPolicy }[] = [];

const recording = (inner: Sandbox): Sandbox => ({
  ...inner,
  spawn: (spec, given, signal, options) => {
    spawned.push({ argv: spec.argv, policy: given });
    return inner.spawn(spec, given, signal, options);
  },
});

const request = (command: string, extra: Record<string, unknown> = {}) => ({
  command,
  sandbox: recording(createUnsandboxed({ killGraceMs: 200 })),
  sandboxPolicy: policy(),
  env: { PATH: '/usr/bin:/bin' },
  shellHost: nodeShellHost(),
  cwd: dir,
  markerFile: path.join(dir, 'markers', 'verify-1'),
  clock: { now: () => Date.now() },
  signal: new AbortController().signal,
  timeoutMs: 30_000,
  ...extra,
});

describe('runSandboxedCommand', () => {
  beforeEach(() => {
    spawned.length = 0;
  });

  it('runs the command through the sandbox with the given policy and reports exit 0', async () => {
    const given = request('echo hello; echo warn >&2');
    const result = await runSandboxedCommand(given);
    expect(result).toMatchObject({ kind: 'exited', exitCode: 0, stdout: 'hello\n', stderr: 'warn\n' });
    expect(spawned).toHaveLength(1);
    expect(spawned[0]?.argv.at(-1)).toBe('echo hello; echo warn >&2');
    expect(spawned[0]?.policy).toBe(given.sandboxPolicy);
  });

  it('reports a non-zero exit code as exited with that code', async () => {
    expect(await runSandboxedCommand(request('exit 3'))).toMatchObject({ kind: 'exited', exitCode: 3 });
  });

  it('runs in the given directory', async () => {
    expect(await runSandboxedCommand(request('pwd'))).toMatchObject({ kind: 'exited', exitCode: 0, stdout: `${dir}\n` });
  });

  it('kills the process group at the timeout and reports timed_out', async () => {
    const started = Date.now();
    const result = await runSandboxedCommand(request('sleep 30', { timeoutMs: 300 }));
    expect(result.kind).toBe('timed_out');
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('reports a process killed by a signal as signaled, not exited', async () => {
    expect(await runSandboxedCommand(request('kill -9 $$'))).toMatchObject({ kind: 'signaled', signal: 'SIGKILL' });
  });

  it('reports cancelled and leaves no live process holding the marker when the signal aborts', async () => {
    const controller = new AbortController();
    const given = request('sleep 30 & sleep 30; wait', { signal: controller.signal });
    const running = runSandboxedCommand(given);
    setTimeout(() => controller.abort(), 300);
    expect((await running).kind).toBe('cancelled');
    expect(fs.existsSync(given.markerFile) ? await findHolders(given.markerFile, { signal: new AbortController().signal }) : []).toEqual([]);
  });

  it('removes the marker file after a normal exit', async () => {
    const given = request('true');
    await runSandboxedCommand(given);
    expect(fs.existsSync(given.markerFile)).toBe(false);
  });
});
