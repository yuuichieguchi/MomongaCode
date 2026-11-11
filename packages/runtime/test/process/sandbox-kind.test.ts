import { spawn } from '@momonga/testkit/child-process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { canonicalJson, groupAlive, sha256Hex } from '@momonga/foundation';
import { createUnsandboxed } from '@momonga/sandbox';
import { REAL_PROCESS_TEST_TIMEOUT_MS, waitFor, TEST_CHILD_UNPROTECTED } from '@momonga/testkit';
import { createRun, createSession, makeRuntimeFixture, makeTempHome, runBashThroughPort, signalNever, trackGroup, writeUserSettings } from './helpers.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const groupExists = (pgid: number): Promise<boolean> => groupAlive(pgid);

const spawnStubbornHolder = (marker: string): number => {
  const fd = fs.openSync(marker, 'w', 0o600);
  let pid: number | undefined;
  try {
    const child = spawn('/bin/sh', ['-c', "trap '' TERM; exec sleep 30"], { detached: true, stdio: ['ignore', 'ignore', 'ignore', fd] });
    pid = child.pid;
  } finally {
    fs.closeSync(fd);
  }
  if (pid === undefined) throw new Error('holder did not spawn');
  trackGroup(pid);
  return pid;
};

describe('sandbox kind (system timers, none used)', () => {
  it('with sandbox none, Bash asks even in bypassPermissions', async () => {
    const f = await makeRuntimeFixture({ sandbox: createUnsandboxed({ protection: TEST_CHILD_UNPROTECTED, platform: process.platform, killGraceMs: 300 }) });
    writeUserSettings(f.temp.home, {});
    const session = createSession(f.store, f.temp.project, { env: { PATH: '/usr/bin:/bin' } });
    const runId = await createRun(f.store, session.id);

    const { outcome } = await runBashThroughPort(f, session, runId, 'echo hi', 'bypassPermissions');

    expect(outcome.kind).toBe('needs_approval');
    if (outcome.kind !== 'needs_approval') return;
    expect(outcome.decision).toEqual({ kind: 'ask', source: 'mode', humanOnly: true, reason: 'no sandbox is available: file deny rules are checked on the command text only, so command execution requires approval' });
    expect(outcome.suggestedRule).toBeUndefined();
  });

  it('a lease of ToolRuntimePort.sandboxes holds the instance given', async () => {
    const sandbox = createUnsandboxed({ protection: TEST_CHILD_UNPROTECTED, platform: process.platform });
    const f = await makeRuntimeFixture({ sandbox });

    const lease = await f.toolRuntime.port.sandboxes.acquire(signalNever());
    try {
      expect(lease.value.sandbox).toBe(sandbox);
      expect(lease.value.sandbox.kind).toBe('none');
    } finally {
      lease.release();
    }
  });

  it('the executor reaps with the composition ReapTiming', async () => {
    const temp = await makeTempHome();
    const f = await makeRuntimeFixture({ temp });
    const idemKey = sha256Hex(canonicalJson(['run-reap', 1, 'call-a']));
    const marker = path.join(temp.paths.markers.tools, idemKey);
    const pgid = spawnStubbornHolder(marker);
    await waitFor(() => groupExists(pgid), { description: 'the holder to start' });
    f.store.idempotency.begin(idemKey, { expiresAt: f.clock.now() + 3_600_000, meta: { tool: 'Bash' } });
    f.store.idempotency.attachProcess(idemKey, { pgid, startedAt: f.clock.now() });
    const startedAt = f.clock.now();

    const outcomes = await f.toolRuntime.port.executor.abandon([{ callId: 'call-a', idemKey }], { signal: signalNever() });

    expect(outcomes).toEqual([{ idemKey, callId: 'call-a', outcome: 'unknown' }]);
    expect(f.reapTiming.sleeps.length).toBeGreaterThan(0);
    expect(f.clock.now()).toBeGreaterThan(startedAt);
    await waitFor(async () => !(await groupExists(pgid)), { description: 'the stubborn holder to be killed' });
    expect(fs.existsSync(marker)).toBe(false);
    expect(f.store.idempotency.get(idemKey)?.s).toBe('UNKNOWN');
  });
});
