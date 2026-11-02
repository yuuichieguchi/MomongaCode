import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GHOST_CONFIRM_MS } from '@momonga/foundation';
import { createFakeClock, createFakeEntryIo, createFakeTimers, fakeReapTiming, parseJsonLines, registerCleanup, spawnTracked, waitFor } from '@momonga/testkit';
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
  turns,
  validSettings,
  writeLockFile,
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
  lockSleeps: number[];
  code: Promise<number>;
  timers: ReturnType<typeof createFakeTimers>;
  clock: ReturnType<typeof createFakeClock>;
  exited(): boolean;
  supervisorLog(): JsonLine[];
};

const startEntry = (context: CleanupContext, prepare: (paths: MomongaPaths) => void, deps: Partial<SupervisorEntryDeps>): SlowRun => {
  const { home, paths } = prepareHome(context);
  writeSettings(home, validSettings());
  prepare(paths);
  const clock = createFakeClock(T0);
  const timers = createFakeTimers(clock);
  const io = createFakeEntryIo({
    argv: [`--app-version=${TEST_VERSION}`, `--home=${home}`, '--log-target=file'],
    home,
    env: { PATH: '/usr/bin:/bin', HOME: home, LANG: 'C' },
    clock,
    timers,
  });
  const lockSleeps: number[] = [];
  const realWork = createRealWorkScope();
  const fake = createFakeSpawn({ realWork });
  const code = realWork.run(() =>
    runSupervisorEntry(io, {
      launcher: fakeLauncher,
      spawn: fake.port,
      markerPorts: recordingMarkerPorts({}).ports,
      random: () => 0.5,
      watchSettings: false,
      reapTiming: fakeReapTiming(clock, timers),
      lockTiming: {
        now: () => clock.now(),
        sleep: (ms) => {
          lockSleeps.push(ms);
          timers.advance(ms);
          return Promise.resolve();
        },
      },
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
    for (let round = 0; round < 2000 && !done; round += 1) {
      timers.advance(1000);
      await turns(5);
    }
  });
  return {
    realWork,
    io,
    paths,
    lockSleeps,
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

const cancelDuringStaleLockProbe = (context: CleanupContext, lockPathOf: (paths: MomongaPaths) => string): { run: SlowRun; holderProbes(): number } => {
  const holder = spawnTracked(context, 'sleep', ['30']);
  let probes = 0;
  let io: FakeEntryIo | undefined;
  const run = startEntry(context, (paths) => writeLockFile(lockPathOf(paths), holder.pid, Date.now() - 3_600_000), {
    startTimeOf: async (pid) => {
      if (pid === holder.pid) {
        probes += 1;
        io?.signal('SIGTERM');
      }
      return Date.now();
    },
  });
  io = run.io;
  return { run, holderProbes: () => probes };
};

type CancelledExit = { run: SlowRun; code: number; fakeMsAfterCancel: number };

const cancelAndExit = async (context: CleanupContext, latencyMs: number, lockPathOf: (paths: MomongaPaths) => string, maxMs: number): Promise<CancelledExit> => {
  fsLatency.ms = latencyMs;
  const { run, holderProbes } = cancelDuringStaleLockProbe(context, lockPathOf);
  await waitFor(() => holderProbes() === 2, {
    description: 'the ghost confirmation probe',
  });
  expect(run.lockSleeps).toEqual([GHOST_CONFIRM_MS]);
  const cancelledAt = run.clock.now();
  const code = await exitOf(run, maxMs);
  return { run, code, fakeMsAfterCancel: run.clock.now() - cancelledAt };
};

const supervisorLockOf = (paths: MomongaPaths): string => paths.locks.supervisor;
const socketLockOf = (paths: MomongaPaths): string => `${paths.sockets.supervisor}.lock`;

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
    expect(fs.existsSync(slow.run.paths.locks.supervisor)).toBe(false);
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
    expect(fs.existsSync(slow.run.paths.sockets.supervisor)).toBe(false);
    expect(fs.existsSync(`${slow.run.paths.sockets.supervisor}.lock`)).toBe(false);
    expect(fs.existsSync(slow.run.paths.locks.supervisor)).toBe(false);
  });
});
