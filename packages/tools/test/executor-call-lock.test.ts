import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Timing } from '@momonga/foundation';
import { REAL_PROCESS_TEST_TIMEOUT_MS, startLockHolder, withTempDir, sleepDrivenTiming, testProcessInspector, testKernelLock } from '@momonga/testkit';
import { heldCallWaitMs, sweepCallLocks } from '@momonga/tools';
import { createCallLocks } from '../src/call-lock.ts';
import { call, makeHarness, makeTool, toolSetOf } from './harness.ts';
import type { Harness } from './harness.ts';
import { deferred, keyFor } from './helpers.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const KEY = keyFor('run-1', 1, 'c1');
const HOLDER_PID = 4242;
const HEARTBEAT_MS = 100;

const lockPathOf = (harness: Harness): string => path.join(harness.callLockDir, `${KEY}.lock`);

const gatedFirstPoll = () => {
  let current = 0;
  let first = true;
  const polled = deferred<void>();
  const resumed = deferred<void>();
  const timing: Timing = sleepDrivenTiming({
    now: () => current,
    sleep: async (ms) => {
      current += ms;
      if (first) {
        first = false;
        polled.resolve();
        await resumed.promise;
      }
    },
  });
  return { timing, polled: polled.promise, resume: (): void => resumed.resolve() };
};

const advancingTiming = (): Timing => {
  let current = 0;
  return sleepDrivenTiming({
    now: () => current,
    sleep: async (ms) => {
      current += ms;
    },
  });
};

const hostPollingTiming = () => {
  const polled = deferred<void>();
  const timing: Timing = sleepDrivenTiming({
    now: () => Date.now(),
    sleep: (ms) =>
      new Promise<void>((resolve) => {
        polled.resolve();
        setTimeout(resolve, ms);
      }),
  });
  return { timing, polled: polled.promise };
};

const makeTrace = () => {
  const events: string[] = [];
  const first = deferred<void>();
  return {
    events,
    note: (event: string): void => {
      events.push(event);
      first.resolve();
    },
    firstEvent: first.promise,
  };
};

type Trace = ReturnType<typeof makeTrace>;

const reconcilingTool = (name: string, sideEffect: 'write' | 'exec', trace: Trace) =>
  makeTool(name, {
    kind: sideEffect === 'exec' ? 'execute' : 'edit',
    sideEffect,
    subjectKind: 'none',
    execute: async () => {
      trace.note('execute');
      return { status: 'completed', output: 'ran' };
    },
    reconcile: async () => {
      trace.note('reconcile');
      return { outcome: 'already_applied', output: 'reconciled' };
    },
  });

describe('the per-call lock of the executor', () => {
  it('does not reconcile while another attempt holds the call lock, and reconciles once it is released', async () => {
    const waiting = gatedFirstPoll();
    const harness = makeHarness({ executor: { reap: { inspector: testProcessInspector(), timing: waiting.timing } } });
    const trace = makeTrace();
    harness.idempotency.seed(KEY, 'PENDING', { tool: 'Edit' });
    harness.kernelLock.holdExternally(lockPathOf(harness), HOLDER_PID);

    const batch = harness.executor.runBatch(await harness.input(await toolSetOf(reconcilingTool('Edit', 'write', trace)), [call('c1', 'Edit', {}, 'allow_once')]));
    await Promise.race([waiting.polled, trace.firstEvent]);
    expect(trace.events).toEqual([]);
    expect(harness.idempotency.authorised).toEqual([]);

    harness.kernelLock.releaseExternally(lockPathOf(harness));
    waiting.resume();
    const [outcome] = await batch;

    expect(trace.events).toEqual(['reconcile']);
    expect(outcome).toMatchObject({ kind: 'result', reconciled: 'already_applied' });
    expect(harness.kernelLock.isHeldBy(lockPathOf(harness))).toBeUndefined();
  });

  it('fails with a typed error naming the holder when the lock stays held for the wait derived from the heartbeat, and neither reconciles nor executes', async () => {
    const harness = makeHarness({ executor: { reap: { inspector: testProcessInspector(), timing: advancingTiming() }, heartbeatMs: HEARTBEAT_MS } });
    const trace = makeTrace();
    harness.idempotency.seed(KEY, 'PENDING', { tool: 'Edit' });
    harness.kernelLock.holdExternally(lockPathOf(harness), HOLDER_PID);

    await expect(harness.executor.runBatch(await harness.input(await toolSetOf(reconcilingTool('Edit', 'write', trace)), [call('c1', 'Edit', {}, 'allow_once')]))).rejects.toMatchObject({
      name: 'EarlierAttemptNotStoppedError',
      code: 'earlier_attempt_not_stopped',
      reason: 'lock_held',
      message: expect.stringContaining(`process ${HOLDER_PID} after ${heldCallWaitMs(HEARTBEAT_MS)} ms`),
    });

    expect(trace.events).toEqual([]);
    expect(harness.idempotency.stateOf(KEY)).toBe('PENDING');
  });

  it('takes the lock for a fresh execution too, so an earlier attempt cannot start its effect after this one begins', async () => {
    const waiting = gatedFirstPoll();
    const harness = makeHarness({ executor: { reap: { inspector: testProcessInspector(), timing: waiting.timing } } });
    const trace = makeTrace();
    harness.kernelLock.holdExternally(lockPathOf(harness), HOLDER_PID);

    const batch = harness.executor.runBatch(await harness.input(await toolSetOf(reconcilingTool('Write', 'write', trace)), [call('c1', 'Write', {}, 'allow_once')]));
    await Promise.race([waiting.polled, trace.firstEvent]);
    expect(trace.events).toEqual([]);

    harness.kernelLock.releaseExternally(lockPathOf(harness));
    waiting.resume();
    await batch;

    expect(trace.events).toEqual(['execute']);
  });

  it('does not take the lock for a read only tool', async () => {
    const harness = makeHarness();
    harness.kernelLock.holdExternally(lockPathOf(harness), HOLDER_PID);
    const tool = makeTool('Read', { sideEffect: 'read_only', subjectKind: 'none', execute: async () => ({ status: 'completed', output: 'read' }) });

    const [outcome] = await harness.executor.runBatch(await harness.input(await toolSetOf(tool), [call('c1', 'Read')]));

    expect(outcome).toMatchObject({ kind: 'result', result: { status: 'completed', output: 'read' } });
  });

  it('releases the lock and removes its file when the call ends', async () => {
    const harness = makeHarness();
    const tool = reconcilingTool('Write', 'write', makeTrace());

    await harness.executor.runBatch(await harness.input(await toolSetOf(tool), [call('c1', 'Write', {}, 'allow_once')]));

    expect(harness.kernelLock.isHeldBy(lockPathOf(harness))).toBeUndefined();
    expect(fs.readdirSync(harness.callLockDir)).toEqual([]);
  });

  it('excludes a second acquisition inside one process through the host kernel mechanism, until the first lock is released', async (context) => {
    const dir = withTempDir(context);
    const polling = hostPollingTiming();
    const locks = createCallLocks({ dir, mechanism: testKernelLock(), timing: polling.timing, waitMs: 60_000 });
    const none = new AbortController().signal;
    const first = await locks.acquire(KEY, none);
    if (first === 'aborted') throw new Error('the first acquisition was aborted');
    let secondAcquired = false;
    const second = locks.acquire(KEY, none).then((lock) => {
      secondAcquired = true;
      return lock;
    });

    await polling.polled;
    expect(secondAcquired).toBe(false);
    first.release();
    const held = await second;
    if (held === 'aborted') throw new Error('the second acquisition was aborted');
    held.release();

    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('stops waiting for the lock when the call is aborted', async () => {
    const waiting = gatedFirstPoll();
    const harness = makeHarness({ executor: { reap: { inspector: testProcessInspector(), timing: waiting.timing } } });
    harness.idempotency.seed(KEY, 'PENDING', { tool: 'Edit' });
    harness.kernelLock.holdExternally(lockPathOf(harness), HOLDER_PID);
    const trace = makeTrace();
    const controller = new AbortController();

    const batch = harness.executor.runBatch(
      await harness.input(await toolSetOf(reconcilingTool('Edit', 'write', trace)), [call('c1', 'Edit', {}, 'allow_once')], { signal: controller.signal }),
    );
    await Promise.race([waiting.polled, trace.firstEvent]);
    controller.abort();
    waiting.resume();
    const [outcome] = await batch;

    expect(outcome).toMatchObject({ kind: 'result', result: { status: 'failed' } });
    expect(trace.events).toEqual([]);
    expect(harness.idempotency.stateOf(KEY)).toBe('PENDING');
  });

  it('the sweep removes every lock file nobody holds and keeps the lock file a live holder has (20.35, R1)', async () => {
    const harness = makeHarness();
    fs.writeFileSync(path.join(harness.callLockDir, 'a.lock'), '123');
    fs.writeFileSync(path.join(harness.callLockDir, 'b.lock'), '');
    fs.writeFileSync(path.join(harness.callLockDir, 'held.lock'), String(HOLDER_PID));
    harness.kernelLock.holdExternally(path.join(harness.callLockDir, 'held.lock'), HOLDER_PID);

    await sweepCallLocks({ dir: harness.callLockDir, mechanism: harness.kernelLock });

    expect(fs.readdirSync(harness.callLockDir)).toEqual(['held.lock']);
    expect(harness.kernelLock.isHeldBy(path.join(harness.callLockDir, 'held.lock'))).toBe('external');
  });

  it('the sweep leaves a lock held through the host kernel mechanism by this process in place', async (context) => {
    const dir = withTempDir(context);
    const mechanism = testKernelLock();
    const held = await mechanism.claim(path.join(dir, 'live.lock'));
    if (held.kind !== 'claimed') throw new Error('the first claim of a fresh lock file was refused');
    fs.writeFileSync(path.join(dir, 'stale.lock'), '');
    try {
      await sweepCallLocks({ dir, mechanism });
      expect(fs.readdirSync(dir)).toEqual(['live.lock']);
    } finally {
      held.lock.dispose();
    }
  });

  it('stops the marker of an earlier attempt that another generation left, after it holds the call lock (20.35)', async () => {
    const trace = makeTrace();
    const lockStates: (string | undefined)[] = [];
    const place: { harness?: Harness; otherGeneration?: string } = {};
    const harness = makeHarness({
      executor: {
        earlierMarkerDirs: async () => {
          if (place.harness === undefined || place.otherGeneration === undefined) throw new Error('the harness is not ready');
          lockStates.push(place.harness.kernelLock.isHeldBy(lockPathOf(place.harness)));
          return [place.otherGeneration];
        },
      },
    });
    const otherGeneration = path.join(path.dirname(harness.callLockDir), 'markers-g1-tools');
    place.harness = harness;
    place.otherGeneration = otherGeneration;
    fs.mkdirSync(otherGeneration, { mode: 0o700 });
    fs.writeFileSync(path.join(otherGeneration, KEY), '');
    harness.idempotency.seed(KEY, 'PENDING', { tool: 'Edit' });

    const [outcome] = await harness.executor.runBatch(await harness.input(await toolSetOf(reconcilingTool('Edit', 'write', trace)), [call('c1', 'Edit', {}, 'allow_once')]));

    expect(outcome).toMatchObject({ kind: 'result', reconciled: 'already_applied' });
    expect(lockStates).toEqual(['claim']);
    expect(fs.existsSync(path.join(otherGeneration, KEY))).toBe(false);
  });

  it.each([
    ['Write', 'write'],
    ['Edit', 'write'],
    ['Bash', 'exec'],
  ] as const)('%s: an older attempt of the same process whose effect is still running ends its effect before the new owner reconciles', async (name, sideEffect) => {
    const waiting = gatedFirstPoll();
    const harness = makeHarness({ executor: { reap: { inspector: testProcessInspector(), timing: waiting.timing } } });
    const trace = makeTrace();
    const effectRunning = deferred<void>();
    const effectMayEnd = deferred<void>();
    const reconcileRan = deferred<void>();
    let olderLeaseLost = false;
    const tool = makeTool(name, {
      kind: sideEffect === 'exec' ? 'execute' : 'edit',
      sideEffect,
      subjectKind: 'none',
      execute: async () => {
        trace.note('effect-start');
        effectRunning.resolve();
        await effectMayEnd.promise;
        trace.note('effect-end');
        return { status: 'completed', output: 'older finished' };
      },
      reconcile: async () => {
        trace.note('reconcile');
        reconcileRan.resolve();
        return { outcome: 'already_applied', output: 'reconciled' };
      },
    });
    const toolSet = await toolSetOf(tool);
    const older =harness.executor.runBatch(await harness.input(toolSet, [call('c1', name, {}, 'allow_once')], { leaseLost: () => olderLeaseLost }));
    await effectRunning.promise;

    const newer = harness.executor.runBatch(await harness.input(toolSet, [call('c1', name, {}, 'allow_once')]));
    await Promise.race([waiting.polled, reconcileRan.promise]);
    expect(trace.events).toEqual(['effect-start']);

    olderLeaseLost = true;
    effectMayEnd.resolve();
    waiting.resume();
    const [deferredOutcome] = await older;
    const [reconciled] = await newer;

    expect(deferredOutcome).toMatchObject({ kind: 'deferred' });
    expect(reconciled).toMatchObject({ kind: 'result', reconciled: 'already_applied' });
    expect(trace.events).toEqual(['effect-start', 'effect-end', 'reconcile']);
  });

  it('waits for a process that holds the call lock through the kernel and reconciles only after that process is killed', async (context) => {
    const polling = hostPollingTiming();
    const harness = makeHarness({ executor: { kernelLock: testKernelLock(), reap: { inspector: testProcessInspector(), timing: polling.timing } } });
    const trace = makeTrace();
    harness.idempotency.seed(KEY, 'PENDING', { tool: 'Edit' });
    const holder = await startLockHolder(context, lockPathOf(harness));

    const batch = harness.executor.runBatch(await harness.input(await toolSetOf(reconcilingTool('Edit', 'write', trace)), [call('c1', 'Edit', {}, 'allow_once')]));
    await Promise.race([polling.polled, trace.firstEvent]);
    expect(trace.events).toEqual([]);
    expect(harness.idempotency.authorised).toEqual([]);

    const exited = new Promise<void>((resolve) => holder.once('exit', () => resolve()));
    holder.kill('SIGKILL');
    await exited;
    const [outcome] = await batch;

    expect(trace.events).toEqual(['reconcile']);
    expect(outcome).toMatchObject({ kind: 'result', reconciled: 'already_applied' });
  });
});
