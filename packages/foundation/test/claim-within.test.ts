import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { claimWithin, withFileLock } from '@momonga/foundation';
import type { FileLockPorts, KernelLockMechanism, ReapTiming } from '@momonga/foundation';
import { createFakeKernelLock, withTempDir } from '@momonga/testkit';

const HOLDER_PID = 4242;
const POLL_MS = 7;
const WAIT_MS = 21;

type RecordingTiming = ReapTiming & { sleeps: number[] };

const recordingTiming = (onSleep: (sleeps: number) => void = () => undefined): RecordingTiming => {
  let current = 0;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => current,
    sleep: async (ms) => {
      current += ms;
      sleeps.push(ms);
      onSleep(sleeps.length);
    },
  };
};

const fileLockPorts = (timing: ReapTiming): FileLockPorts => ({
  clock: { now: () => timing.now() },
  sleep: (ms) => timing.sleep(ms),
  randomHex: () => 'deadbeef',
});

const request = (mechanism: KernelLockMechanism, lockPath: string, timing: ReapTiming, signal: AbortSignal = new AbortController().signal) => ({
  mechanism,
  lockPath,
  holder: '77',
  timing,
  pollMs: POLL_MS,
  waitMs: WAIT_MS,
  signal,
});

describe('claimWithin', () => {
  it('claims a free lock without sleeping and records the holder', async (context) => {
    const lockPath = path.join(withTempDir(context), 'a.lock');
    const fake = createFakeKernelLock({ inheritable: false });
    const timing = recordingTiming();

    const outcome = await claimWithin(request(fake, lockPath, timing));

    expect(outcome.kind).toBe('claimed');
    expect(timing.sleeps).toEqual([]);
    expect(await fake.readHolder(lockPath)).toBe('77');
    expect(fake.isHeldBy(lockPath)).toBe('claim');
  });

  it('polls at the given interval and claims once the holder lets go', async (context) => {
    const lockPath = path.join(withTempDir(context), 'a.lock');
    const fake = createFakeKernelLock({ inheritable: false });
    fake.holdExternally(lockPath, HOLDER_PID);
    const timing = recordingTiming((count) => {
      if (count === 2) fake.releaseExternally(lockPath);
    });

    const outcome = await claimWithin(request(fake, lockPath, timing));

    expect(outcome.kind).toBe('claimed');
    expect(timing.sleeps).toEqual([POLL_MS, POLL_MS]);
  });

  it('reports the recorded holder when the wait runs out, and leaves the lock alone', async (context) => {
    const lockPath = path.join(withTempDir(context), 'a.lock');
    const fake = createFakeKernelLock({ inheritable: false });
    fake.holdExternally(lockPath, HOLDER_PID);
    const timing = recordingTiming();

    const outcome = await claimWithin(request(fake, lockPath, timing));

    expect(outcome).toEqual({ kind: 'timed_out', holder: String(HOLDER_PID) });
    expect(timing.sleeps).toEqual([POLL_MS, POLL_MS, POLL_MS]);
    expect(fake.isHeldBy(lockPath)).toBe('external');
  });

  it('does not claim at all under a signal that is already aborted', async (context) => {
    const lockPath = path.join(withTempDir(context), 'a.lock');
    const fake = createFakeKernelLock({ inheritable: false });
    const controller = new AbortController();
    controller.abort();

    const outcome = await claimWithin(request(fake, lockPath, recordingTiming(), controller.signal));

    expect(outcome).toEqual({ kind: 'aborted' });
    expect(fake.claimsMade()).toEqual([]);
  });

  it('stops polling when the signal aborts during the wait, even though the lock came free', async (context) => {
    const lockPath = path.join(withTempDir(context), 'a.lock');
    const fake = createFakeKernelLock({ inheritable: false });
    fake.holdExternally(lockPath, HOLDER_PID);
    const controller = new AbortController();
    const timing = recordingTiming(() => {
      fake.releaseExternally(lockPath);
      controller.abort();
    });

    const outcome = await claimWithin(request(fake, lockPath, timing, controller.signal));

    expect(outcome).toEqual({ kind: 'aborted' });
    expect(timing.sleeps).toEqual([POLL_MS]);
    expect(fake.claimsMade()).toEqual([]);
  });

  it('releases the claim and keeps the error when the holder cannot be written', async (context) => {
    const lockPath = path.join(withTempDir(context), 'missing', 'a.lock');
    const fake = createFakeKernelLock({ inheritable: false });

    await expect(claimWithin(request(fake, lockPath, recordingTiming()))).rejects.toMatchObject({ code: 'ENOENT' });

    expect(fake.isHeldBy(lockPath)).toBeUndefined();
  });

  it('does not retry a claim that failed for a reason other than being held', async (context) => {
    const lockPath = path.join(withTempDir(context), 'a.lock');
    const failure = Object.assign(new Error('denied'), { code: 'EACCES' });
    const fake = createFakeKernelLock({ inheritable: false });
    const timing = recordingTiming();

    await expect(claimWithin(request({ ...fake, claim: () => Promise.reject(failure) }, lockPath, timing))).rejects.toBe(failure);

    expect(timing.sleeps).toEqual([]);
  });
});

describe('withFileLock as an adapter of claimWithin', () => {
  it('claims through the injected mechanism and records this process as the holder', async (context) => {
    const lockPath = path.join(withTempDir(context), 'a.lock');
    const fake = createFakeKernelLock({ inheritable: false });
    let holderDuringTask: string | undefined;

    await withFileLock(
      lockPath,
      async () => {
        holderDuringTask = await fake.readHolder(lockPath);
      },
      { ports: fileLockPorts(recordingTiming()), mechanism: fake },
    );

    expect(fake.claimsMade()).toEqual([lockPath]);
    expect(holderDuringTask).toBe(String(process.pid));
    expect(fake.isHeldBy(lockPath)).toBeUndefined();
  });

  it('stops waiting with the reason of the signal and never runs the task', async (context) => {
    const lockPath = path.join(withTempDir(context), 'a.lock');
    const fake = createFakeKernelLock({ inheritable: false });
    fake.holdExternally(lockPath, HOLDER_PID);
    const controller = new AbortController();
    const timing = recordingTiming(() => controller.abort());
    let runs = 0;

    const failure = withFileLock(
      lockPath,
      async () => {
        runs += 1;
      },
      { ports: fileLockPorts(timing), mechanism: fake, signal: controller.signal, timeoutMs: 1000 },
    );

    const rejection: unknown = await failure.catch((error: unknown) => error);
    expect(controller.signal.aborted).toBe(true);
    expect(rejection).toBe(controller.signal.reason);
    expect(timing.sleeps).toHaveLength(1);
    expect(runs).toBe(0);
  });

  it('names the injected holder on timeout', async (context) => {
    const lockPath = path.join(withTempDir(context), 'a.lock');
    const fake = createFakeKernelLock({ inheritable: false });
    fake.holdExternally(lockPath, HOLDER_PID);

    const failure = withFileLock(lockPath, async () => undefined, { ports: fileLockPorts(recordingTiming()), mechanism: fake, timeoutMs: 50 });

    await expect(failure).rejects.toThrow(`timed out after 50ms waiting for lock ${lockPath} held by process ${HOLDER_PID}`);
  });

  it('frees the lock and never runs the task when the holder cannot be written', async (context) => {
    const lockPath = path.join(withTempDir(context), 'missing', 'a.lock');
    const fake = createFakeKernelLock({ inheritable: false });
    let runs = 0;

    const failure = withFileLock(
      lockPath,
      async () => {
        runs += 1;
      },
      { ports: fileLockPorts(recordingTiming()), mechanism: fake },
    );

    await expect(failure).rejects.toMatchObject({ code: 'ENOENT' });
    expect(fake.claimsMade()).toEqual([lockPath]);
    expect(fake.isHeldBy(lockPath)).toBeUndefined();
    expect(runs).toBe(0);
  });
});
