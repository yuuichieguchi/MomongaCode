import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EMPTY_FILE_RULES, EMPTY_PROTECTED_SET } from '@momonga/foundation';
import type { HookExecution } from '@momonga/protocol';
import { createUnsandboxed } from '@momonga/sandbox';
import { createMarkerOwners, createToolHooks, nodeShellHost, unsettledKeys } from '@momonga/tools';
import type { HookRunContext } from '@momonga/tools';
import { REAL_PROCESS_TEST_TIMEOUT_MS } from '@momonga/testkit';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('T16 (c) a hook run in flight owns its marker', { timeout: REAL_PROCESS_TEST_TIMEOUT_MS }, () => {
  it('while the hook runs its marker is not in the unsettled set, and the hook finishes untouched', async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mm-hook-owner-')));
    dirs.push(dir);
    const markerDir = path.join(dir, 'markers');
    fs.mkdirSync(markerDir);
    const ready = path.join(dir, 'ready');
    const go = path.join(dir, 'go');
    const owners = createMarkerOwners();
    const executions: HookExecution[] = [];
    const context = {
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: `touch ${ready}; while [ ! -e ${go} ]; do sleep 0.02; done` }] }] },
      sandbox: createUnsandboxed({ killGraceMs: 200 }),
      sandboxPolicy: { writableRoots: [dir], writeDenied: [], writeDeniedLiterals: [], readDenied: [], network: 'deny', fileRules: EMPTY_FILE_RULES, protectedSet: EMPTY_PROTECTED_SET },
      env: { PATH: '/usr/bin:/bin' },
      shellHost: nodeShellHost(),
      cwd: dir,
      projectDir: dir,
      markerDir,
      runId: 'run-1',
      session: { id: 's1', permissionMode: 'default' },
      clock: { now: () => Date.now() },
      signal: new AbortController().signal,
      deadlineAt: Date.now() + 60_000,
      report: (execution: HookExecution) => void executions.push(execution),
      owners,
    } as unknown as HookRunContext;
    const running = createToolHooks(context).preToolUse({ callId: 'c1', toolName: 'Bash', input: { command: 'ls' } });
    for (let turn = 0; turn < 500 && !fs.existsSync(ready); turn += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fs.readdirSync(markerDir).filter((name) => name.startsWith('hook-'))).toHaveLength(1);
    expect(await unsettledKeys(markerDir, owners)).toEqual([]);
    fs.writeFileSync(go, '');
    await running;
    expect(executions.map((execution) => execution.outcome)).toEqual(['success']);
  });
});
