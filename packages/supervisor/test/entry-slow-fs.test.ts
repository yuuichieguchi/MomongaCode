import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hostKernelLock, inspectProcessLock } from '@momonga/foundation';
import type { KernelLockMechanism } from '@momonga/foundation';
import { createFakeClock, createFakeEntryIo, createFakeTimers, fakeReapTiming, parseJsonLines, registerCleanup, firstGeneration } from '@momonga/testkit';
import type { CleanupContext, FakeEntryIo, JsonLine } from '@momonga/testkit';
import { runSupervisorEntry } from '../src/entry.ts';
import type { SupervisorEntryDeps } from '../src/entry.ts';
import {
  T0,
  TEST_VERSION,
  createFakeSpawn,
  createRealWorkScope,
  fakeLauncher,
  prepareHome,
  pumpUntil,
  recordingMarkerPorts,
  validSettings,
  writeSettings,
} from './fixtures/p3-harness.ts';
import type { MomongaPaths } from '@momonga/foundation';

const fsLatency = vi.hoisted(() => ({ ms: 0 }));

vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs')>();
  const realPromises = original.promises as unknown as Record<string, unknown>;
  const slowPromises: Record<string, unknown> = {};
  for (const [name, member] of Object.entries(realPromises)) {
    slowPromises[name] =
      typeof member === 'function' && name !== 'constants'
        ? async (...args: unknown[]) => {
            await new Promise((resolve) => setTimeout(resolve, fsLatency.ms));
            return (member as (...callArgs: unknown[]) => unknown).apply(realPromises, args);
          }
        : member;
  }
  const slowFs = { ...original, promises: slowPromises };
  return { ...slowFs, default: slowFs };
});

type SlowRun = {
  realWork: ReturnType<typeof createRealWorkScope>;
  io: FakeEntryIo;
  paths: MomongaPaths;
  code: Promise<number>;
  timers: ReturnType<typeof createFakeTimers>;
  clock: ReturnType<typeof createFakeClock>;
  exited(): boolean;
  supervisorLog(): JsonLine[];
};

const startEntry = (context: CleanupContext, prepared: { home: string; paths: MomongaPaths }, lockMechanism: KernelLockMechanism, deps: Partial<SupervisorEntryDeps>): SlowRun => {
  const { home, paths } = prepared;
  writeSettings(home, validSettings());
  const clock = createFakeClock(T0);
  const timers = createFakeTimers(clock);
  const io = createFakeEntryIo({
    argv: [`--home=${home}`, '--log-target=file'],
    home,
    env: { PATH: '/usr/bin:/bin', HOME: home, LANG: 'C' },
    clock,
    timers,
    lockMechanism,
  });
  const realWork = createRealWorkScope();
  const fake = createFakeSpawn({ realWork });
  const code = realWork.run(() =>
    runSupervisorEntry(io, {
      version: TEST_VERSION,
      launcher: fakeLauncher,
      spawn: fake.port,
      markerPorts: recordingMarkerPorts({}).ports,
      random: () => 0.5,
      watchSettings: false,
      reapTiming: fakeReapTiming(clock, timers),
      lockMechanism,
      ...deps,
    }),
  );
  let done = false;
  const markDone = (): void => {
    done = true;
  };
  void code.then(markDone, markDone);
  registerCleanup(context, async () => {
    fake.dieOnAnySignal();
    io.signal('SIGINT');
    await pumpUntil(timers, () => done, { realWork, maxMs: 2_000_000, description: 'the supervisor entry to finish' });
  });
  return {
    realWork,
    io,
    paths,
    code,
    timers,
    clock,
    exited: () => done,
    supervisorLog: () => parseJsonLines(io.logLines(paths.logFiles.supervisor)),
  };
};

const exitOf = async (run: SlowRun, maxMs: number): Promise<number> => {
  await pumpUntil(run.timers, () => run.exited(), { maxMs, description: 'entry exit', realWork: run.realWork });
  return run.code;
};

const cancelOnClaim = (target: string, cancel: () => void): KernelLockMechanism => {
  const host = hostKernelLock();
  return {
    ...host,
    claim: async (lockPath) => {
      if (lockPath === target) cancel();
      return host.claim(lockPath);
    },
  };
};

type CancelledExit = { run: SlowRun; code: number; fakeMsAfterCancel: number };

const cancelAndExit = async (context: CleanupContext, latencyMs: number, lockPathOf: (paths: MomongaPaths) => string, maxMs: number): Promise<CancelledExit> => {
  fsLatency.ms = latencyMs;
  const prepared = prepareHome(context);
  let io: FakeEntryIo | undefined;
  const run = startEntry(context, prepared, cancelOnClaim(lockPathOf(prepared.paths), () => io?.signal('SIGTERM')), {});
  io = run.io;
  const cancelledAt = run.clock.now();
  const code = await exitOf(run, maxMs);
  return { run, code, fakeMsAfterCancel: run.clock.now() - cancelledAt };
};

const supervisorLockOf = (paths: MomongaPaths): string => firstGeneration(paths).locks.supervisor;
const socketLockOf = (paths: MomongaPaths): string => `${firstGeneration(paths).sockets.supervisor}.lock`;

describe('supervisor entry under slow filesystem I/O', () => {
  afterEach(() => {
    fsLatency.ms = 0;
  });

  it('the startup cancel exits with startup-cancelled and releases the lock even when every fs operation is slow', async (context) => {
    const fast = await cancelAndExit(context, 0, supervisorLockOf, 5000);
    const slow = await cancelAndExit(context, 5, supervisorLockOf, 5000);
    expect(slow.code).toBe(1);
    expect(fast.fakeMsAfterCancel).toBe(0);
    expect(slow.fakeMsAfterCancel).toBe(0);
    expect(slow.run.supervisorLog().at(-1)).toMatchObject({
      msg: 'entry.exit',
      path: 'startup-cancelled',
      trigger: 'sigterm',
      code: 1,
    });
    expect(slow.run.io.stdoutLines()).toEqual([]);
    expect(await inspectProcessLock(firstGeneration(slow.run.paths).locks.supervisor)).toEqual({ state: 'free' });
  });

  it('a cancel during listenUnix closes gracefully and removes the socket and both locks even when every fs operation is slow', async (context) => {
    const fast = await cancelAndExit(context, 0, socketLockOf, 30_000);
    const slow = await cancelAndExit(context, 20, socketLockOf, 30_000);
    expect(slow.code).toBe(0);
    expect(fast.fakeMsAfterCancel).toBe(0);
    expect(slow.fakeMsAfterCancel).toBe(0);
    expect(slow.run.io.stdoutLines()).toHaveLength(1);
    expect(slow.run.supervisorLog().at(-1)).toMatchObject({
      msg: 'entry.exit',
      path: 'close',
      trigger: 'sigterm',
      code: 0,
    });
    expect(fs.existsSync(firstGeneration(slow.run.paths).sockets.supervisor)).toBe(false);
    expect(await inspectProcessLock(`${firstGeneration(slow.run.paths).sockets.supervisor}.lock`)).toEqual({ state: 'free' });
    expect(await inspectProcessLock(firstGeneration(slow.run.paths).locks.supervisor)).toEqual({ state: 'free' });
  });
});
