import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { hostKernelLock } from '@momonga/foundation';
import type { ReapTiming } from '@momonga/foundation';
import { startLockHolder } from '@momonga/testkit';
import { clearCallLocks } from '@momonga/tools';
import { call, makeHarness, makeTool, toolSetOf } from './harness.ts';
import type { Harness } from './harness.ts';
import { deferred, keyFor } from './helpers.ts';

const KEY = keyFor('run-1', 1, 'c1');
const HOLDER_PID = 4242;

const lockPathOf = (harness: Harness): string => path.join(harness.callLockDir, `${KEY}.lock`);

const gatedFirstPoll = () => {
  let current = 0;
  let first = true;
  const polled = deferred<void>();
  const resumed = deferred<void>();
  const timing: ReapTiming = {
    now: () => current,
    sleep: async (ms) => {
      current += ms;
      if (first) {
        first = false;
        polled.resolve();
        await resumed.promise;
      }
    },
  };
  return { timing, polled: polled.promise, resume: (): void => resumed.resolve() };
};

const advancingTiming = (): ReapTiming => {
  let current = 0;
  return {
    now: () => current,
    sleep: async (ms) => {
      current += ms;
    },
  };
};

const hostPollingTiming = () => {
  const polled = deferred<void>();
  const timing: ReapTiming = {
    now: () => Date.now(),
    sleep: (ms) =>
      new Promise<void>((resolve) => {
        polled.resolve();
        setTimeout(resolve, ms);
      }),
  };
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
    const harness = makeHarness({ executor: { reap: { timing: waiting.timing } } });
    const trace = makeTrace();
    harness.idempotency.seed(KEY, 'PENDING', { tool: 'Edit' });
    harness.kernelLock.holdExternally(lockPathOf(harness), HOLDER_PID);

    const batch = harness.executor.runBatch(harness.input(await toolSetOf(reconcilingTool('Edit', 'write', trace)), [call('c1', 'Edit', {}, 'allow_once')]));
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

  it('fails with a typed error naming the holder when the lock stays held for the reconcile cap, and neither reconciles nor executes', async () => {
    const harness = makeHarness({ executor: { reap: { timing: advancingTiming() }, reconcileCapMs: 100 } });
    const trace = makeTrace();
    harness.idempotency.seed(KEY, 'PENDING', { tool: 'Edit' });
    harness.kernelLock.holdExternally(lockPathOf(harness), HOLDER_PID);

    await expect(harness.executor.runBatch(harness.input(await toolSetOf(reconcilingTool('Edit', 'write', trace)), [call('c1', 'Edit', {}, 'allow_once')]))).rejects.toMatchObject({
      name: 'EarlierAttemptNotStoppedError',
      code: 'earlier_attempt_not_stopped',
      reason: 'lock_held',
      message: expect.stringContaining(`process ${HOLDER_PID}`),
    });

    expect(trace.events).toEqual([]);
    expect(harness.idempotency.stateOf(KEY)).toBe('PENDING');
  });

  it('takes the lock for a fresh execution too, so an earlier attempt cannot start its effect after this one begins', async () => {
    const waiting = gatedFirstPoll();
    const harness = makeHarness({ executor: { reap: { timing: waiting.timing } } });
    const trace = makeTrace();
    harness.kernelLock.holdExternally(lockPathOf(harness), HOLDER_PID);

    const batch = harness.executor.runBatch(harness.input(await toolSetOf(reconcilingTool('Write', 'write', trace)), [call('c1', 'Write', {}, 'allow_once')]));
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
    const tool = makeTool('Read', { sideEffect: 'read_only', execute: async () => ({ status: 'completed', output: 'read' }) });

    const [outcome] = await harness.executor.runBatch(harness.input(await toolSetOf(tool), [call('c1', 'Read')]));

    expect(outcome).toMatchObject({ kind: 'result', result: { status: 'completed', output: 'read' } });
  });

  it('releases the lock and removes its file when the call ends', async () => {
    const harness = makeHarness();
    const tool = reconcilingTool('Write', 'write', makeTrace());

    await harness.executor.runBatch(harness.input(await toolSetOf(tool), [call('c1', 'Write', {}, 'allow_once')]));

    expect(harness.kernelLock.isHeldBy(lockPathOf(harness))).toBeUndefined();
    expect(fs.readdirSync(harness.callLockDir)).toEqual([]);
  });

  it('clears every lock file a crashed process left behind', async () => {
    const harness = makeHarness();
    fs.writeFileSync(path.join(harness.callLockDir, 'a.lock'), '123');
    fs.writeFileSync(path.join(harness.callLockDir, 'b.lock'), '');

    await clearCallLocks(harness.callLockDir);

    expect(fs.readdirSync(harness.callLockDir)).toEqual([]);
  });

  it.each([
    ['Write', 'write'],
    ['Edit', 'write'],
    ['Bash', 'exec'],
  ] as const)('%s: an older attempt of the same process whose effect is still running ends its effect before the new owner reconciles', async (name, sideEffect) => {
    const waiting = gatedFirstPoll();
    const harness = makeHarness({ executor: { reap: { timing: waiting.timing } } });
    const trace = makeTrace();
    const effectRunning = deferred<void>();
    const effectMayEnd = deferred<void>();
    const reconcileRan = deferred<void>();
    let olderLeaseLost = false;
    const tool = makeTool(name, {
      kind: sideEffect === 'exec' ? 'execute' : 'edit',
      sideEffect,
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
    const older =harness.executor.runBatch(harness.input(toolSet, [call('c1', name, {}, 'allow_once')], { leaseLost: () => olderLeaseLost }));
    await effectRunning.promise;

    const newer = harness.executor.runBatch(harness.input(toolSet, [call('c1', name, {}, 'allow_once')]));
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
    const harness = makeHarness({ executor: { kernelLock: hostKernelLock(), reap: { timing: polling.timing } } });
    const trace = makeTrace();
    harness.idempotency.seed(KEY, 'PENDING', { tool: 'Edit' });
    const holder = await startLockHolder(context, lockPathOf(harness));

    const batch = harness.executor.runBatch(harness.input(await toolSetOf(reconcilingTool('Edit', 'write', trace)), [call('c1', 'Edit', {}, 'allow_once')]));
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
