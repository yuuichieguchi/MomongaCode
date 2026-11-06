import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { REAP_POLL_INTERVAL_MS, createUninspectableRegistry, findHolders } from '@momonga/foundation';
import type { ProcessInspector, ReapTiming, SignalSender, UninspectableRegistry } from '@momonga/foundation';
import { REAL_PROCESS_TEST_TIMEOUT_MS, killGroupsForCleanup, killPidsForCleanup } from '@momonga/testkit';
import { call, makeHarness, makeTool, toolSetOf } from './harness.ts';
import type { Harness, HarnessOptions } from './harness.ts';
import { deferred, keyFor } from './helpers.ts';

const PROCESS_TIMEOUT = { timeout: REAL_PROCESS_TEST_TIMEOUT_MS };
const STUBBORN_GRACE_MS = 100;
const KEY_A = keyFor('run-1', 1, 'call-a');
const KEY_B = keyFor('run-1', 1, 'call-b');

const groups: number[] = [];
const pids: number[] = [];

afterEach(async () => {
  killPidsForCleanup(pids.splice(0));
  await killGroupsForCleanup(groups.splice(0));
});

const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

const groupExists = (pgid: number): boolean => {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

const eventually = async (condition: () => Promise<boolean> | boolean, description: string, attempts = 2000): Promise<void> => {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`condition not reached: ${description}`);
};

const waitUntilGone = async (pgid: number): Promise<void> => {
  const deadline = Date.now() + 5000;
  while (groupExists(pgid)) {
    if (Date.now() > deadline) throw new Error(`process group ${pgid} is still alive`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

const markerOf = (harness: Harness, key: string): string => path.join(harness.markerDir, key);

const spawnHolder = (marker: string, script: string): number => {
  const fd = fs.openSync(marker, 'w', 0o600);
  let pid: number | undefined;
  try {
    const child = spawn('/bin/sh', ['-c', script], { detached: true, stdio: ['ignore', 'ignore', 'ignore', fd] });
    pid = child.pid;
  } finally {
    fs.closeSync(fd);
  }
  if (pid === undefined) throw new Error('holder did not spawn');
  groups.push(pid);
  return pid;
};

const seedPending = (harness: Harness, key: string, pgid?: number): void => {
  harness.idempotency.seed(key, 'PENDING', { tool: 'Bash' });
  if (pgid !== undefined) harness.idempotency.port.attachProcess(key, { pgid, startedAt: harness.clock.now() });
};

const noSignal = (): AbortSignal => new AbortController().signal;

const fakeTiming = (overlapTarget = 1): ReapTiming & { active: number; maxActive: number; sleeps: number } => {
  let now = 0;
  const overlapped = deferred<void>();
  const timing = {
    active: 0,
    maxActive: 0,
    sleeps: 0,
    now: () => now,
    sleep: async (ms: number) => {
      timing.sleeps += 1;
      timing.active += 1;
      timing.maxActive = Math.max(timing.maxActive, timing.active);
      if (timing.maxActive >= overlapTarget) overlapped.resolve();
      await overlapped.promise;
      timing.active -= 1;
      now += ms;
    },
  };
  return timing;
};

const harnessWith = (reap: { kill?: SignalSender; timing?: ReapTiming; killGraceMs?: number; inspector?: ProcessInspector; uninspectable?: UninspectableRegistry }): Harness =>
  makeHarness({ executor: { reap } } as HarnessOptions);

describe('executor abandon', () => {
  it('abandon kills the process group of a PENDING call, marks the record UNKNOWN and returns unknown', PROCESS_TIMEOUT, async () => {
    const harness = makeHarness();
    const marker = markerOf(harness, KEY_A);
    const pgid = spawnHolder(marker, 'exec sleep 30');
    seedPending(harness, KEY_A, pgid);

    const outcomes = await harness.executor.abandon([{ callId: 'call-a', idemKey: KEY_A }], { signal: noSignal() });

    expect(outcomes).toEqual([{ idemKey: KEY_A, callId: 'call-a', outcome: 'unknown' }]);
    expect(groupExists(pgid)).toBe(false);
    expect(fs.existsSync(marker)).toBe(false);
    expect(harness.idempotency.stateOf(KEY_A)).toBe('UNKNOWN');
    expect(harness.idempotency.log.filter((entry) => entry.op === 'markUnknownIfPending')).toEqual([{ op: 'markUnknownIfPending', key: KEY_A, changed: true }]);
    expect(harness.idempotency.log.some((entry) => entry.op === 'markUnknown')).toBe(false);
  });

  it('abandon kills a child that closed fd 3 and the group is gone when it returns', PROCESS_TIMEOUT, async () => {
    const harness = makeHarness();
    const marker = markerOf(harness, KEY_A);
    const pgid = spawnHolder(marker, 'sleep 30 & exec 3>&-; wait');
    seedPending(harness, KEY_A, pgid);
    await eventually(async () => {
      const holders = await findHolders(marker);
      return holders.length === 1 && holders[0] !== pgid;
    }, 'the leader to close fd 3 while its sleep child keeps it');

    const outcomes = await harness.executor.abandon([{ callId: 'call-a', idemKey: KEY_A }], { signal: noSignal() });

    expect(outcomes).toEqual([{ idemKey: KEY_A, callId: 'call-a', outcome: 'unknown' }]);
    expect(groupExists(pgid)).toBe(false);
    expect(fs.existsSync(marker)).toBe(false);
    expect(harness.idempotency.stateOf(KEY_A)).toBe('UNKNOWN');
  });

  it('abandon sweeps a setsid grandchild that still holds the marker', PROCESS_TIMEOUT, async () => {
    const harness = makeHarness();
    const marker = markerOf(harness, KEY_A);
    const pidFile = path.join(harness.layout.root, 'grandchild.pid');
    const pgid = spawnHolder(marker, `perl -MPOSIX -e 'POSIX::setsid(); open(my $f, ">", "${pidFile}.tmp"); print $f $$; close($f); rename("${pidFile}.tmp", "${pidFile}"); sleep 30' & wait`);
    seedPending(harness, KEY_A, pgid);
    await eventually(() => fs.existsSync(pidFile), 'the grandchild to write its pid');
    const grandchild = Number(fs.readFileSync(pidFile, 'utf8'));
    pids.push(grandchild);
    expect(grandchild).toBeGreaterThan(1);
    await eventually(async () => (await findHolders(marker)).includes(grandchild), 'the grandchild to hold the marker');

    const outcomes = await harness.executor.abandon([{ callId: 'call-a', idemKey: KEY_A }], { signal: noSignal() });

    expect(outcomes).toEqual([{ idemKey: KEY_A, callId: 'call-a', outcome: 'unknown' }]);
    expect(groupExists(pgid)).toBe(false);
    expect(pidAlive(grandchild)).toBe(false);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('abandon on a COMPLETED record reaps nothing and marks nothing, and still returns unknown', PROCESS_TIMEOUT, async () => {
    const harness = makeHarness();
    const marker = markerOf(harness, KEY_A);
    const pgid = spawnHolder(marker, 'exec sleep 30');
    harness.idempotency.port.complete(KEY_A, { callId: 'call-a', kind: 'result', result: { status: 'completed', output: 'done' } });

    const outcomes = await harness.executor.abandon([{ callId: 'call-a', idemKey: KEY_A }], { signal: noSignal() });

    expect(outcomes).toEqual([{ idemKey: KEY_A, callId: 'call-a', outcome: 'unknown' }]);
    expect(groupExists(pgid)).toBe(true);
    expect(fs.existsSync(marker)).toBe(true);
    expect(harness.idempotency.stateOf(KEY_A)).toBe('COMPLETED');
    expect(harness.idempotency.log.filter((entry) => entry.op === 'markUnknownIfPending' && entry.changed)).toEqual([]);
  });

  it.each(['UNKNOWN', 'missing'] as const)('abandon on a record that is %s reaps nothing and returns unknown', PROCESS_TIMEOUT, async (state) => {
    const harness = makeHarness();
    const marker = markerOf(harness, KEY_A);
    const pgid = spawnHolder(marker, 'exec sleep 30');
    if (state === 'UNKNOWN') harness.idempotency.seed(KEY_A, 'UNKNOWN', { tool: 'Bash' });

    const outcomes = await harness.executor.abandon([{ callId: 'call-a', idemKey: KEY_A }], { signal: noSignal() });

    expect(outcomes).toEqual([{ idemKey: KEY_A, callId: 'call-a', outcome: 'unknown' }]);
    expect(groupExists(pgid)).toBe(true);
    expect(fs.existsSync(marker)).toBe(true);
    expect(harness.idempotency.stateOf(KEY_A)).toBe(state === 'UNKNOWN' ? 'UNKNOWN' : undefined);
  });

  it('abandon after a lost race with complete() does not throw and does not overwrite COMPLETED', async () => {
    const harness = makeHarness();
    seedPending(harness, KEY_A);
    const originalGet = harness.idempotency.port.get;
    harness.idempotency.port.get = (key) => {
      const found = originalGet(key);
      if (key === KEY_A) harness.idempotency.port.complete(KEY_A, { raced: true });
      return found;
    };

    const outcomes = await harness.executor.abandon([{ callId: 'call-a', idemKey: KEY_A }], { signal: noSignal() });

    expect(outcomes).toEqual([{ idemKey: KEY_A, callId: 'call-a', outcome: 'unknown' }]);
    expect(harness.idempotency.stateOf(KEY_A)).toBe('COMPLETED');
    expect(harness.idempotency.log.filter((entry) => entry.op === 'markUnknownIfPending')).toEqual([{ op: 'markUnknownIfPending', key: KEY_A, changed: false }]);
  });

  it('abandon handles targets concurrently', PROCESS_TIMEOUT, async () => {
    const timing = fakeTiming(2);
    const signalled: Array<{ pid: number; signal: NodeJS.Signals | 0; afterResolve: boolean }> = [];
    let resolved = false;
    const kill: SignalSender = (pid, signal) => {
      signalled.push({ pid, signal, afterResolve: resolved });
      process.kill(pid, signal);
    };
    const harness = harnessWith({ kill, timing });
    const pgidA = spawnHolder(markerOf(harness, KEY_A), 'trap "" TERM; exec sleep 30');
    const pgidB = spawnHolder(markerOf(harness, KEY_B), 'trap "" TERM; exec sleep 30');
    seedPending(harness, KEY_A, pgidA);
    seedPending(harness, KEY_B, pgidB);

    const outcomes = await harness.executor.abandon(
      [
        { callId: 'call-a', idemKey: KEY_A },
        { callId: 'call-b', idemKey: KEY_B },
      ],
      { signal: noSignal() },
    );

    expect(outcomes).toEqual([
      { idemKey: KEY_A, callId: 'call-a', outcome: 'unknown' },
      { idemKey: KEY_B, callId: 'call-b', outcome: 'unknown' },
    ]);
    resolved = true;
    expect(timing.maxActive).toBeGreaterThanOrEqual(2);
    const terminatingBeforeResolve = signalled
      .filter((entry) => !entry.afterResolve && (entry.signal === 'SIGKILL' || entry.signal === 'SIGTERM'))
      .map((entry) => Math.abs(entry.pid));
    expect(terminatingBeforeResolve).toEqual(expect.arrayContaining([pgidA, pgidB]));
    await waitUntilGone(pgidA);
    await waitUntilGone(pgidB);
  });

  it('abandon uses the marker path processMarkerDir/<idemKey>', PROCESS_TIMEOUT, async () => {
    const harness = makeHarness();
    const target = markerOf(harness, KEY_A);
    const bystander = markerOf(harness, KEY_B);
    const holder = spawnHolder(target, 'exec sleep 30');
    const other = spawnHolder(bystander, 'exec sleep 30');
    seedPending(harness, KEY_A);
    seedPending(harness, KEY_B, other);

    await harness.executor.abandon([{ callId: 'call-a', idemKey: KEY_A }], { signal: noSignal() });

    expect(pidAlive(holder)).toBe(false);
    expect(fs.existsSync(target)).toBe(false);
    expect(pidAlive(other)).toBe(true);
    expect(fs.existsSync(bystander)).toBe(true);
    expect(harness.idempotency.stateOf(KEY_B)).toBe('PENDING');
  });

  it('an aborted signal rejects abandon with the reason', async () => {
    const harness = makeHarness();
    seedPending(harness, KEY_A);
    const controller = new AbortController();
    const reason = new Error('the worker is shutting down');
    controller.abort(reason);

    await expect(harness.executor.abandon([{ callId: 'call-a', idemKey: KEY_A }], { signal: controller.signal })).rejects.toBe(reason);

    expect(harness.idempotency.stateOf(KEY_A)).toBe('PENDING');
    expect(harness.idempotency.log.filter((entry) => entry.op === 'markUnknownIfPending')).toEqual([]);
  });

  it('a failing target is rethrown only after the other targets settled', async () => {
    const harness = makeHarness();
    seedPending(harness, KEY_A);
    seedPending(harness, KEY_B);
    const failure = Object.assign(new Error('database disk image is malformed'), { errcode: 11, errstr: 'database disk image is malformed' });
    const originalGet = harness.idempotency.port.get;
    harness.idempotency.port.get = (key) => {
      if (key === KEY_A) throw failure;
      return originalGet(key);
    };

    await expect(
      harness.executor.abandon(
        [
          { callId: 'call-a', idemKey: KEY_A },
          { callId: 'call-b', idemKey: KEY_B },
        ],
        { signal: noSignal() },
      ),
    ).rejects.toBe(failure);

    expect(harness.idempotency.stateOf(KEY_B)).toBe('UNKNOWN');
    expect(harness.idempotency.log.filter((entry) => entry.op === 'markUnknownIfPending')).toEqual([{ op: 'markUnknownIfPending', key: KEY_B, changed: true }]);
  });

  it('a process that survives its kill is a typed failure, the marker stays on disk and the record is still marked UNKNOWN', PROCESS_TIMEOUT, async () => {
    const timing = fakeTiming();
    let stubborn = 0;
    const kill: SignalSender = (pid, signal) => {
      if (signal !== 0 && (pid === stubborn || pid === -stubborn)) return;
      process.kill(pid, signal);
    };
    const harness = harnessWith({ kill, timing, killGraceMs: STUBBORN_GRACE_MS });
    const marker = markerOf(harness, KEY_A);
    stubborn = spawnHolder(marker, 'exec sleep 30');
    seedPending(harness, KEY_A, stubborn);

    await expect(harness.executor.abandon([{ callId: 'call-a', idemKey: KEY_A }], { signal: noSignal() })).rejects.toMatchObject({
      name: 'EarlierAttemptNotStoppedError',
      code: 'earlier_attempt_not_stopped',
      reason: 'survived',
    });

    expect(pidAlive(stubborn)).toBe(true);
    expect(fs.existsSync(marker)).toBe(true);
    expect(harness.warnings).toEqual(
      expect.arrayContaining([`tool marker ${marker} kept: process ${stubborn} still hold it after cleanup; the next start will retry`]),
    );
    expect(harness.idempotency.stateOf(KEY_A)).toBe('UNKNOWN');
    expect(timing.sleeps).toBe(1 + STUBBORN_GRACE_MS / REAP_POLL_INTERVAL_MS);
  });

  it('a target whose marker cannot be removed is a typed failure while the others are still reaped and every target is CAS-ed', PROCESS_TIMEOUT, async () => {
    const harness = makeHarness();
    const brokenMarker = markerOf(harness, KEY_A);
    fs.mkdirSync(path.join(brokenMarker, 'nested'), { recursive: true });
    const marker = markerOf(harness, KEY_B);
    const pgid = spawnHolder(marker, 'exec sleep 30');
    seedPending(harness, KEY_A);
    seedPending(harness, KEY_B, pgid);

    await expect(
      harness.executor.abandon(
        [
          { callId: 'call-a', idemKey: KEY_A },
          { callId: 'call-b', idemKey: KEY_B },
        ],
        { signal: noSignal() },
      ),
    ).rejects.toMatchObject({ name: 'EarlierAttemptNotStoppedError', reason: 'unverifiable', message: expect.stringContaining(brokenMarker) });

    expect(groupExists(pgid)).toBe(false);
    expect(fs.existsSync(marker)).toBe(false);
    expect(harness.idempotency.stateOf(KEY_A)).toBe('UNKNOWN');
    expect(harness.idempotency.stateOf(KEY_B)).toBe('UNKNOWN');
  });

  it('a call lock that stays held is a typed failure, the earlier attempt is not touched and the record is still marked UNKNOWN', async () => {
    let now = 0;
    const timing: ReapTiming = {
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    };
    const harness = makeHarness({ executor: { reap: { timing }, reconcileCapMs: 100 } });
    seedPending(harness, KEY_A);
    harness.kernelLock.holdExternally(path.join(harness.callLockDir, `${KEY_A}.lock`), 4242);

    await expect(harness.executor.abandon([{ callId: 'call-a', idemKey: KEY_A }], { signal: noSignal() })).rejects.toMatchObject({
      name: 'EarlierAttemptNotStoppedError',
      reason: 'lock_held',
    });

    expect(harness.idempotency.stateOf(KEY_A)).toBe('UNKNOWN');
  });
});

describe('executor reconcile of a PENDING call whose earlier attempt is still running', () => {
  it('fails with a typed error when the process survives its kill, never reconciles, keeps the record PENDING and releases the call lock', PROCESS_TIMEOUT, async () => {
    const timing = fakeTiming();
    let stubborn = 0;
    const kill: SignalSender = (pid, signal) => {
      if (signal !== 0 && (pid === stubborn || pid === -stubborn)) return;
      process.kill(pid, signal);
    };
    const harness = harnessWith({ kill, timing, killGraceMs: STUBBORN_GRACE_MS });
    const marker = markerOf(harness, KEY_A);
    stubborn = spawnHolder(marker, 'exec sleep 30');
    seedPending(harness, KEY_A, stubborn);

    const reconciled: string[] = [];
    const tool = makeTool('Bash', {
      kind: 'execute',
      sideEffect: 'exec', subjectKind: 'none',
      reconcile: async () => {
        reconciled.push('reconcile');
        return { outcome: 'unknown', output: 'unknown' };
      },
    });

    await expect(harness.executor.runBatch(harness.input(await toolSetOf(tool), [call('call-a', 'Bash', {}, 'allow_once')]))).rejects.toMatchObject({ name: 'EarlierAttemptNotStoppedError', code: 'earlier_attempt_not_stopped', reason: 'survived' });
    expect(reconciled).toEqual([]);
    expect(pidAlive(stubborn)).toBe(true);
    expect(harness.idempotency.stateOf(KEY_A)).toBe('PENDING');
    expect(harness.kernelLock.isHeldBy(path.join(harness.callLockDir, `${KEY_A}.lock`))).toBeUndefined();
  });

  const unreadable = { pid: 31_340, command: 'ssh-agent', startTicks: '9' };
  const unreadableInspector: ProcessInspector = {
    startTimeOf: async () => ({ kind: 'gone' }),
    holdersOf: async (_marker, report) => {
      report?.(unreadable);
      return { kind: 'value', value: [] };
    },
    groupsOf: async () => ({ kind: 'value', value: new Map() }),
  };
  const unreadableHarness = (): Harness =>
    harnessWith({ inspector: unreadableInspector, uninspectable: createUninspectableRegistry({ isAlive: () => true }), timing: fakeTiming(), killGraceMs: STUBBORN_GRACE_MS });

  it('refuses the earlier attempt as unverifiable when a process holding its marker could not be inspected: the marker is kept and reconcile does not run', async () => {
    const harness = unreadableHarness();
    const marker = markerOf(harness, KEY_A);
    fs.writeFileSync(marker, '', { mode: 0o600 });
    seedPending(harness, KEY_A);

    const seen: unknown[] = [];
    const tool = makeTool('Bash', {
      kind: 'execute',
      sideEffect: 'exec', subjectKind: 'none',
      reconcile: async (_input, _record, ctx) => {
        seen.push(ctx.earlierAttempt);
        return { outcome: 'unknown', output: 'unknown' };
      },
    });

    await expect(harness.executor.runBatch(harness.input(await toolSetOf(tool), [call('call-a', 'Bash', {}, 'allow_once')]))).rejects.toMatchObject({
      name: 'EarlierAttemptNotStoppedError',
      reason: 'unverifiable',
    });
    expect(seen).toEqual([]);
    expect(fs.existsSync(marker)).toBe(true);
    expect(harness.idempotency.stateOf(KEY_A)).toBe('PENDING');
    expect(harness.warnings).toEqual(expect.arrayContaining([`tool marker ${marker}: process 31340 (ssh-agent) could not be inspected, so it was left alone`]));
  });

  it('abandon refuses as unverifiable when a process holding the marker could not be inspected, keeps the marker and still marks the record UNKNOWN', async () => {
    const harness = unreadableHarness();
    const marker = markerOf(harness, KEY_A);
    fs.writeFileSync(marker, '', { mode: 0o600 });
    seedPending(harness, KEY_A);

    await expect(harness.executor.abandon([{ callId: 'call-a', idemKey: KEY_A }], { signal: noSignal() })).rejects.toMatchObject({
      name: 'EarlierAttemptNotStoppedError',
      reason: 'unverifiable',
    });
    expect(fs.existsSync(marker)).toBe(true);
    expect(harness.idempotency.stateOf(KEY_A)).toBe('UNKNOWN');
  });
});
