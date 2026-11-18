import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_FILE_RULES, EMPTY_PROTECTED_SET, hostProcessInspector, hostInspectorPorts, POLL_INTERVAL_MS, systemWaitTiming, waitUntil as foundationWaitUntil } from '@momonga/foundation';
import type { HookExecution, HooksSettings } from '@momonga/protocol';
import { createUnsandboxed } from '@momonga/sandbox';
import type { Sandbox } from '@momonga/sandbox';
import { createToolHooks, nodeShellHost } from '@momonga/tools';
import type { HookRunContext } from '@momonga/tools';
import { createTempDir, killGroupsForCleanup, REAL_PROCESS_TEST_TIMEOUT_MS, TEST_CHILD_UNPROTECTED, testLocks } from '@momonga/testkit';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const NOT_AN_ATTEMPT_RECORD = 'not an attempt record\n';
const notProved = { of: async () => 'unenforced' as const, contradicted: () => undefined };

let dir = '';
let spawnedGroups: number[] = [];

beforeEach(() => {
  dir = createTempDir();
});

afterEach(async () => {
  await killGroupsForCleanup(spawnedGroups.splice(0));
  fs.rmSync(dir, { recursive: true, force: true });
});

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const CONDITION_BOUND_MS = 10_000;

const waitUntil = async (condition: () => boolean): Promise<boolean> =>
  (await foundationWaitUntil(systemWaitTiming, async () => (condition() ? true : undefined), { intervalMs: POLL_INTERVAL_MS, deadline: systemWaitTiming.monotonicMs() + CONDITION_BOUND_MS })).kind === 'found';

const markerCorruptingSandbox = (inner: Sandbox, corrupted: string[]): Sandbox => ({
  kind: inner.kind,
  spawn: async (command, policy, signal, descriptors) => {
    if (command.markerFile !== undefined) {
      fs.writeFileSync(command.markerFile, NOT_AN_ATTEMPT_RECORD);
      corrupted.push(command.markerFile);
    }
    const child = inner.spawn(command, policy, signal, descriptors);
    spawnedGroups.push((await child).pgid);
    return child;
  },
});

describe.runIf(process.platform === 'darwin' || process.platform === 'linux')('a hook whose process group cannot be recorded into its marker', () => {
  it('still waits for the hook to exit, settles its marker with the group held in memory, stops what outlived it, and reports the failed record once', async () => {
    const markerDir = path.join(dir, 'markers');
    fs.mkdirSync(markerDir, { recursive: true });
    const pidFile = path.join(dir, 'outlived.pid');
    const executions: HookExecution[] = [];
    const corrupted: string[] = [];
    const hooks: HooksSettings = { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: `sleep 30 >/dev/null 2>&1 & echo $! > '${pidFile}'; sleep 0.2; exit 0` }] }] };
    const context = {
      hooks,
      sandbox: markerCorruptingSandbox(createUnsandboxed({ protection: TEST_CHILD_UNPROTECTED, platform: process.platform, killGraceMs: 200 }), corrupted),
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
      drainIdleMs: 1000,
      started: () => undefined,
      report: (execution: HookExecution) => void executions.push(execution),
      inspector: hostProcessInspector({ ...hostInspectorPorts(testLocks().capability), capability: notProved } as never),
    } as HookRunContext;

    await createToolHooks(context).preToolUse({ callId: 'c1', toolName: 'Bash', input: { command: 'ls' } });

    const outlived = Number(fs.readFileSync(pidFile, 'utf8').trim());
    expect(corrupted).toHaveLength(1);
    const marker = corrupted[0] ?? '';
    expect(executions).toHaveLength(1);
    expect(executions[0]).toMatchObject({ outcome: 'success', exitCode: 0 });
    expect(await waitUntil(() => !isAlive(outlived))).toBe(true);
    const reported = JSON.stringify(executions);
    expect(reported.split('holds no attempt record the group can follow').length - 1).toBe(1);
    expect(reported).toContain(marker);
  });
});
