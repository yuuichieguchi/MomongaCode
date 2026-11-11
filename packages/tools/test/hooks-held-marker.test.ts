import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_FILE_RULES, EMPTY_PROTECTED_SET, createProcessInspector, hostInspectorPorts, nodeCommandRunner } from '@momonga/foundation';
import type { CommandOptions, CommandRunner } from '@momonga/foundation';
import type { HookExecution, HooksSettings } from '@momonga/protocol';
import { createUnsandboxed } from '@momonga/sandbox';
import { createToolHooks, nodeShellHost } from '@momonga/tools';
import type { HookRunContext } from '@momonga/tools';
import { REAL_PROCESS_TEST_TIMEOUT_MS, testLocks, TEST_CHILD_UNPROTECTED } from '@momonga/testkit';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const LSOF = '/usr/sbin/lsof';

const notProved = { of: async () => 'unenforced' as const, contradicted: () => undefined };

let dir = '';

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mm-hook-held-')));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const failingLsof = (calls: CommandOptions[]): CommandRunner => async (file, args, options) => {
  if (file === LSOF) {
    calls.push(options);
    return { exitCode: 1, stdout: '', stderr: 'lsof: WARNING: injected listing failure\n' };
  }
  return nodeCommandRunner(file, args, options);
};

const contextWith = (command: string, run: CommandRunner) => {
  const markerDir = path.join(dir, 'markers');
  fs.mkdirSync(markerDir, { recursive: true });
  const executions: HookExecution[] = [];
  const hooks: HooksSettings = { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command }] }] };
  const context = {
    hooks,
    sandbox: createUnsandboxed({ protection: TEST_CHILD_UNPROTECTED, platform: process.platform, killGraceMs: 200 }),
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
    deadlineAt: Date.now() + 60_000,
    started: () => undefined,
    report: (execution: HookExecution) => void executions.push(execution),
    inspector: createProcessInspector(process.platform, { ...hostInspectorPorts(testLocks().capability), run, capability: notProved } as never),
  } as HookRunContext;
  return { context, executions, markerDir };
};

describe.runIf(process.platform === 'darwin')('T2 hook variant: the holder state of a finished hook is unknown', () => {
  it('returns the real hook result, keeps the marker and asks the injected inspector under the hook signal with no private timeout', async () => {
    const calls: CommandOptions[] = [];
    const { context, executions, markerDir } = contextWith('echo ok >/dev/null; exit 0', failingLsof(calls));
    await createToolHooks(context).preToolUse({ callId: 'c1', toolName: 'Bash', input: { command: 'ls' } });
    expect(executions.map((execution) => execution.outcome)).toEqual(['success']);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((options) => options.timeoutMs === undefined && options.signal instanceof AbortSignal)).toBe(true);
    expect(fs.readdirSync(markerDir).filter((name) => name.startsWith('hook-'))).toHaveLength(1);
  });

  it('a blocking hook keeps its own decision when the holder state is unknown', async () => {
    const { context, executions, markerDir } = contextWith('echo denied >&2; exit 2', failingLsof([]));
    await createToolHooks(context).preToolUse({ callId: 'c1', toolName: 'Bash', input: { command: 'ls' } });
    expect(executions).toMatchObject([{ outcome: 'blocked', exitCode: 2, decision: 'deny', message: 'denied' }]);
    expect(fs.readdirSync(markerDir).filter((name) => name.startsWith('hook-'))).toHaveLength(1);
  });
});
