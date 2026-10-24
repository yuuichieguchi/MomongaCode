import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { GHOST_CONFIRM_MS, parseReadyLine } from '@momonga/foundation';
import type { SupervisorHealth } from '@momonga/protocol';
import { createFakeClock, createFakeEntryIo, createFakeTimers, fakeReapTiming, parseJsonLines, registerCleanup, spawnTracked, waitFor } from '@momonga/testkit';
import type { CleanupContext, FakeEntryIo, JsonLine } from '@momonga/testkit';
import type { MomongaPaths } from '@momonga/foundation';
import { runSupervisorEntry } from '../src/entry.ts';
import type { SupervisorEntryDeps } from '../src/entry.ts';
import {
  T0,
  TEST_VERSION,
  createFakeSpawn,
  drive,
  fakeLauncher,
  httpOver,
  prepareHome,
  pumpUntil,
  recordingMarkerPorts,
  turns,
  validSettings,
  writeLockFile,
  writeMarker,
  writeSettings,
} from './fixtures/p3-harness.ts';
import type { FakeSpawn, MarkerCalls } from './fixtures/p3-harness.ts';
import type { MarkerPorts } from '../src/orphans.ts';

type EntryRun = {
  io: FakeEntryIo;
  home: string;
  paths: MomongaPaths;
  fake: FakeSpawn;
  timers: ReturnType<typeof createFakeTimers>;
  clock: ReturnType<typeof createFakeClock>;
  markers: MarkerCalls;
  lockSleeps: number[];
  code: Promise<number>;
  supervisorLog(): JsonLine[];
  exited(): boolean;
};

type EntryOptions = {
  deps?: Partial<SupervisorEntryDeps>;
  markerPorts?: MarkerPorts;
  prepare?: (home: string, paths: MomongaPaths) => void;
  argvHome?: boolean;
};

const startEntry = (context: CleanupContext, options: EntryOptions = {}): EntryRun => {
  const { home, paths } = prepareHome(context);
  writeSettings(home, validSettings());
  options.prepare?.(home, paths);
  const clock = createFakeClock(T0);
  const timers = createFakeTimers(clock);
  const io = createFakeEntryIo({
    argv: [`--app-version=${TEST_VERSION}`, ...(options.argvHome === false ? [] : [`--home=${home}`]), '--log-target=file'],
    home,
    env: { PATH: '/usr/bin:/bin', HOME: home, LANG: 'C' },
    clock,
    timers,
  });
  const fake = createFakeSpawn();
  const markers = recordingMarkerPorts(options.markerPorts ?? {});
  const lockSleeps: number[] = [];
  const code = runSupervisorEntry(io, {
    launcher: fakeLauncher,
    spawn: fake.port,
    markerPorts: markers.ports,
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
    ...options.deps,
  });
  let done = false;
  void code.then(
    () => {
      done = true;
    },
    () => {
      done = true;
    },
  );
  registerCleanup(context, async () => {
    fake.dieOnAnySignal();
    io.signal('SIGINT');
    for (let round = 0; round < 2000 && !done; round += 1) {
      timers.advance(1000);
      await turns(5);
    }
  });
  return {
    io,
    home,
    paths,
    fake,
    timers,
    clock,
    markers: markers.calls,
    lockSleeps,
    code,
    supervisorLog: () => parseJsonLines(io.logLines(paths.logFiles.supervisor)),
    exited: () => done,
  };
};

const ready = async (run: EntryRun): Promise<void> => {
  await waitFor(() => run.io.stdoutLines().length === 1 || run.exited(), { description: 'supervisor ready line' });
  expect(run.exited()).toBe(false);
};

const childrenReady = async (run: EntryRun): Promise<void> => {
  await ready(run);
  await pumpUntil(
    run.timers,
    () => run.fake.spawnCount('gateway') >= 1 && run.fake.spawnCount('runtime') >= 1 && run.supervisorLog().filter((line) => line.msg === 'child.ready').length >= 2,
    { stepMs: 50, maxMs: 10_000, description: 'both children ready' },
  );
};

const exitOf = async (run: EntryRun, maxMs = 200_000): Promise<number> => {
  await drive(run.timers, () => run.exited(), { stepMs: 50, maxSteps: Math.ceil(maxMs / 50), description: 'entry exit' });
  return run.code;
};

const lastLine = (run: EntryRun): JsonLine | undefined => run.supervisorLog().at(-1);

describe('runSupervisorEntry', () => {
  it('ready line goes to stdout only and carries the control socket', async (context) => {
    const run = startEntry(context);
    await ready(run);
    const fields = parseReadyLine(run.io.stdoutLines()[0] ?? '');
    expect(fields).toMatchObject({ service: 'supervisor', pid: process.pid, version: TEST_VERSION, socketPath: run.paths.sockets.supervisor });
    expect(run.io.stderrLines()).toEqual([]);
  });

  it('SIGTERM through the engine runs close()', async (context) => {
    const run = startEntry(context);
    await childrenReady(run);
    run.io.signal('SIGTERM');
    expect(await exitOf(run)).toBe(0);
    expect(lastLine(run)).toMatchObject({ msg: 'entry.exit', path: 'close', clean: true, trigger: 'sigterm', code: 0 });
    expect(run.fake.latest('runtime').signals).toEqual(['SIGTERM']);
    expect(run.fake.latest('gateway').signals).toEqual(['SIGTERM']);
    expect(run.io.exits).toEqual([0]);
  });

  it('exit codes: a killed child gives 1', async (context) => {
    const run = startEntry(context);
    await childrenReady(run);
    run.fake.setBehaviour('runtime', { onTerm: 'ignore' });
    run.io.signal('SIGTERM');
    expect(await exitOf(run)).toBe(1);
    expect(lastLine(run)).toMatchObject({ msg: 'entry.exit', path: 'close', clean: false, code: 1 });
    expect(run.fake.latest('runtime').groupKills).toBe(1);
  });

  it('SIGTERM during the reap exits 0 through close()', async (context) => {
    const run = startEntry(context, {
      prepare: (_home, paths) => void writeMarker(paths, 'runtime-old'),
      markerPorts: { findHolders: async () => [999_999] },
    });
    await ready(run);
    await waitFor(() => run.markers.findHolders.length > 0);
    run.io.signal('SIGTERM');
    expect(await exitOf(run)).toBe(0);
    expect(lastLine(run)).toMatchObject({ msg: 'entry.exit', path: 'close', trigger: 'sigterm', code: 0 });
    expect(run.fake.spawnCount()).toBe(0);
  });

  it('shutdown through runSupervisorEntry exits 0 with trigger request', async (context) => {
    const run = startEntry(context);
    await childrenReady(run);
    run.fake.setBehaviour('runtime', { onTerm: 'ignore' });
    expect((await httpOver(context, run.paths.sockets.supervisor, 'POST', '/v1/shutdown')).status).toBe(202);
    await waitFor(() => run.fake.latest('runtime').signals.length === 1);
    expect((await httpOver(context, run.paths.sockets.supervisor, 'POST', '/v1/shutdown')).status).toBe(202);
    await waitFor(() => run.supervisorLog().filter((line) => line.msg === 'entry.shutdown_requested').length === 2);
    run.fake.latest('runtime').exit(0);
    expect(await exitOf(run)).toBe(0);
    expect(lastLine(run)).toMatchObject({ msg: 'entry.exit', path: 'close', trigger: 'request', clean: true, code: 0 });
    expect(run.fake.latest('runtime').signals).toEqual(['SIGTERM']);
    expect(run.fake.latest('gateway').signals).toEqual(['SIGTERM']);
    expect(run.fake.children.flatMap((child) => child.signals)).not.toContain('SIGINT');
  });

  it('second supervisor on the same home exits 75', async (context) => {
    const holder = spawnTracked(context, 'sleep', ['30']);
    const run = startEntry(context, {
      prepare: (_home, paths) => writeLockFile(paths.locks.supervisor, holder.pid),
      deps: { startTimeOf: async () => 0 },
    });
    expect(await exitOf(run, 5000)).toBe(75);
    expect(run.io.stdoutLines()).toEqual([]);
    expect(lastLine(run)).toMatchObject({ msg: 'entry.exit', path: 'start-failed', code: 75 });
  });

  it('a cancel during the supervisor lock acquisition is a startup cancel', async (context) => {
    const holder = spawnTracked(context, 'sleep', ['30']);
    let io: FakeEntryIo | undefined;
    let holderProbes = 0;
    let lockPath = '';
    const run = startEntry(context, {
      prepare: (_home, paths) => {
        lockPath = paths.locks.supervisor;
        writeLockFile(paths.locks.supervisor, holder.pid, Date.now() - 3_600_000);
      },
      deps: {
        startTimeOf: async (pid) => {
          if (pid === holder.pid) {
            holderProbes += 1;
            io?.signal('SIGTERM');
          }
          return Date.now();
        },
      },
    });
    io = run.io;
    await waitFor(() => holderProbes === 2, { description: 'the ghost confirmation probe of the supervisor lock' });
    expect(run.lockSleeps).toEqual([GHOST_CONFIRM_MS]);
    expect(await exitOf(run, 5000)).toBe(1);
    expect(lastLine(run)).toMatchObject({ msg: 'entry.exit', path: 'startup-cancelled', trigger: 'sigterm', code: 1 });
    expect(run.io.stdoutLines()).toEqual([]);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('a cancel during listenUnix still announces ready and closes gracefully', async (context) => {
    const holder = spawnTracked(context, 'sleep', ['30']);
    let io: FakeEntryIo | undefined;
    let holderProbes = 0;
    const run = startEntry(context, {
      prepare: (_home, paths) => writeLockFile(`${paths.sockets.supervisor}.lock`, holder.pid, Date.now() - 3_600_000),
      deps: {
        startTimeOf: async (pid) => {
          if (pid === holder.pid) {
            holderProbes += 1;
            io?.signal('SIGTERM');
          }
          return Date.now();
        },
      },
    });
    io = run.io;
    await waitFor(() => holderProbes === 2, { description: 'the ghost confirmation probe of the socket lock' });
    expect(run.lockSleeps).toEqual([GHOST_CONFIRM_MS]);
    expect(await exitOf(run, 30_000)).toBe(0);
    expect(run.io.stdoutLines()).toHaveLength(1);
    expect(lastLine(run)).toMatchObject({ msg: 'entry.exit', path: 'close', trigger: 'sigterm', code: 0 });
    expect(run.fake.spawnCount()).toBe(0);
    expect(fs.existsSync(run.paths.sockets.supervisor)).toBe(false);
    expect(fs.existsSync(`${run.paths.sockets.supervisor}.lock`)).toBe(false);
    expect(fs.existsSync(run.paths.locks.supervisor)).toBe(false);
  });

  it('fatal after ready: the engine aborts and the children are stopped', async (context) => {
    let explode = false;
    const run = startEntry(context, {
      deps: {
        random: () => {
          if (explode) throw new Error('random exploded');
          return 0.5;
        },
      },
    });
    await childrenReady(run);
    explode = true;
    run.fake.latest('runtime').exit(1);
    expect(await exitOf(run)).toBe(1);
    expect(run.fake.latest('gateway').signals).toEqual(['SIGINT']);
    expect(lastLine(run)).toMatchObject({ msg: 'entry.exit', trigger: 'fatal', code: 1 });
    expect(run.supervisorLog().filter((line) => line.msg === 'supervisor.background_failed')).toHaveLength(1);
  });

  it('home comes canonicalised from io.home when --home is absent', async (context) => {
    const run = startEntry(context, { argvHome: false });
    await ready(run);
    expect(parseReadyLine(run.io.stdoutLines()[0] ?? '')?.socketPath).toBe(run.paths.sockets.supervisor);
  });

  it('health.logs.droppedLines follows the sink', async (context) => {
    const run = startEntry(context);
    await ready(run);
    const health = async (): Promise<SupervisorHealth> => JSON.parse((await httpOver(context, run.paths.sockets.supervisor, 'GET', '/v1/health')).text) as SupervisorHealth;
    expect((await health()).logs.droppedLines).toBe(0);
    run.io.setDroppedLines(run.paths.logFiles.supervisor, 7);
    expect((await health()).logs.droppedLines).toBe(7);
  });

  it('the supervisor opens only supervisor.log', async (context) => {
    const run = startEntry(context);
    await childrenReady(run);
    const runtime = run.fake.latest('runtime');
    runtime.writeStderr('TypeError: boom');
    runtime.writeStdout('a stray stdout line');
    runtime.exit(1);
    await pumpUntil(run.timers, () => run.fake.spawnCount('runtime') === 2, { stepMs: 50, maxMs: 10_000 });
    expect(run.io.logFilePaths).toEqual([run.paths.logFiles.supervisor]);
    const lines = run.supervisorLog();
    expect(lines).toContainEqual(expect.objectContaining({ msg: 'child.stderr', child: 'runtime', childPid: runtime.pid, raw: 'TypeError: boom' }));
    expect(lines).toContainEqual(expect.objectContaining({ msg: 'child.stdout', child: 'runtime', childPid: runtime.pid, raw: 'a stray stdout line' }));
    expect(run.io.logLines(run.paths.logFiles.runtime)).toEqual([]);
    expect(run.io.logLines(run.paths.logFiles.gateway)).toEqual([]);
  });
});
