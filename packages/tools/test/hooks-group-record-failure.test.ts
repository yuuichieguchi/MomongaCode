import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_FILE_RULES, EMPTY_PROTECTED_SET, createProcessInspector, hostInspectorPorts } from '@momonga/foundation';
import type { HookExecution, HooksSettings } from '@momonga/protocol';
import { createUnsandboxed } from '@momonga/sandbox';
import type { Sandbox } from '@momonga/sandbox';
import { createToolHooks, nodeShellHost } from '@momonga/tools';
import type { HookRunContext } from '@momonga/tools';
import { REAL_PROCESS_TEST_TIMEOUT_MS, killGroupsForCleanup, testLocks } from '@momonga/testkit';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const NOT_AN_ATTEMPT_RECORD = 'not an attempt record\n';
const notProved = { of: async () => 'unenforced' as const, contradicted: () => undefined };

let dir = '';
let spawnedGroups: number[] = [];

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mm-hook-record-')));
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

const waitUntil = async (condition: () => boolean, attempts = 2000): Promise<boolean> => {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return condition();
};

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
      sandbox: markerCorruptingSandbox(createUnsandboxed({ killGraceMs: 200 }), corrupted),
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
      inspector: createProcessInspector(process.platform, { ...hostInspectorPorts(testLocks().capability), capability: notProved } as never),
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
