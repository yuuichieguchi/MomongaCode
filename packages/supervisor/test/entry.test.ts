import fs from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { EXIT_CONFIG, EXIT_OK, LIFELINE_FD, generationLayout, inspectProcessLock, parseReadyLine } from '@momonga/foundation';
import type { KernelLockMechanism } from '@momonga/foundation';
import type { SupervisorHealth } from '@momonga/protocol';
import { REAL_PROCESS_TEST_TIMEOUT_MS, createFakeKernelLock, createFakeClock, createFakeEntryIo, createFakeTimers, fakeReapTiming, parseJsonLines, prepareGenerationForTest, registerCleanup, startLockHolder, waitFor, firstGeneration, testKernelLock } from '@momonga/testkit';
import type { CleanupContext, FakeEntryIo, JsonLine } from '@momonga/testkit';
import type { MomongaPaths } from '@momonga/foundation';
import { runSupervisorEntry } from '../src/entry.ts';
import type { SupervisorEntryDeps } from '../src/entry.ts';
import {
  T0,
  TEST_VERSION,
  createFakeSpawn,
  createRealWorkScope,
  fakeLauncher,
  httpOver,
  prepareHome,
  pumpUntil,
  recordingMarkerPorts,
  validSettings,
  writeMarker,
  writeSettings,
} from './fixtures/p3-harness.ts';
import type { FakeSpawn, FakeSpawnOptions, MarkerCalls, RealWorkScope } from './fixtures/p3-harness.ts';
import type { MarkerPorts } from '../src/orphans.ts';
import { testHostPath } from '@momonga/testkit';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

type EntryRun = {
  realWork: RealWorkScope;
  io: FakeEntryIo;
  home: string;
  paths: MomongaPaths;
  fake: FakeSpawn;
  timers: ReturnType<typeof createFakeTimers>;
  clock: ReturnType<typeof createFakeClock>;
  markers: MarkerCalls;
  code: Promise<number>;
  supervisorLog(): JsonLine[];
  exited(): boolean;
};

type EntryOptions = {
  deps?: Partial<SupervisorEntryDeps>;
  markerPorts?: MarkerPorts;
  prepare?: (home: string, paths: MomongaPaths) => void;
  prepared?: { home: string; paths: MomongaPaths };
  lockMechanism?: KernelLockMechanism;
  argvHome?: boolean;
  generationFlag?: string | false;
  behaviours?: FakeSpawnOptions['behaviours'];
  lifelineFd?: number;
};

const cancelOnClaim = (target: string, cancel: () => void): KernelLockMechanism => {
  const host = testKernelLock();
  return {
    ...host,
    claim: async (lockPath) => {
      if (lockPath === target) cancel();
      return host.claim(lockPath);
    },
  };
};

const startEntry = (context: CleanupContext, options: EntryOptions = {}): EntryRun => {
  const { home, paths } = options.prepared ?? prepareHome(context);
  writeSettings(home, validSettings());
  prepareGenerationForTest(home, 1, TEST_VERSION);
  options.prepare?.(home, paths);
  const clock = createFakeClock(T0);
  const timers = createFakeTimers(clock);
  const io = createFakeEntryIo({
    argv: [...(options.argvHome === false ? [] : [`--home=${home}`]), ...(options.generationFlag === false ? [] : [`--generation=${options.generationFlag ?? '1'}`]), ...(options.lifelineFd === undefined ? [] : [`--lifeline-fd=${options.lifelineFd}`]), '--log-target=file'],
    home,
    env: { PATH: testHostPath('/usr/bin:/bin'), HOME: home, LANG: 'C' },
    clock,
    timers,
    ...(options.lockMechanism === undefined ? {} : { lockMechanism: options.lockMechanism }),
  });
  const markers = recordingMarkerPorts(options.markerPorts ?? {});
  const realWork = createRealWorkScope();
  const deliveredIo: FakeEntryIo = {
    ...io,
    signal: (name) => realWork.run(() => io.signal(name)),
    endLifeline: () => realWork.run(() => io.endLifeline()),
    uncaught: (error) => realWork.run(() => io.uncaught(error)),
  };
  const fake = createFakeSpawn({ realWork, ...(options.behaviours === undefined ? {} : { behaviours: options.behaviours }) });
  const code = realWork.run(() => runSupervisorEntry(io, {
    version: TEST_VERSION,
    launcher: fakeLauncher,
    spawn: fake.port,
    markerPorts: markers.ports,
    random: () => 0.5,
    watchSettings: false,
    reapTiming: fakeReapTiming(clock, timers),
    childCounts: async () => ({}),
    ...(options.lockMechanism === undefined ? {} : { lockMechanism: options.lockMechanism }),
    ...options.deps,
  }));
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
    deliveredIo.signal('SIGINT');
    await pumpUntil(timers, () => done, { realWork, maxMs: 2_000_000, description: 'the supervisor entry to finish' });
  });
  return {
    realWork,
    io: deliveredIo,
    home,
    paths,
    fake,
    timers,
    clock,
    markers: markers.calls,
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
    { maxMs: 10_000, description: 'both children ready', realWork: run.realWork },
  );
};

const exitOf = async (run: EntryRun, maxMs = 200_000): Promise<number> => {
  await pumpUntil(run.timers, () => run.exited(), { maxMs, description: 'entry exit', realWork: run.realWork });
  return run.code;
};

const lastLine = (run: EntryRun): JsonLine | undefined => run.supervisorLog().at(-1);

describe('runSupervisorEntry', () => {
  it('ready line goes to stdout only and carries the control socket', async (context) => {
    const run = startEntry(context);
    await ready(run);
    const fields = parseReadyLine(run.io.stdoutLines()[0] ?? '');
    expect(fields).toMatchObject({ service: 'supervisor', pid: process.pid, version: TEST_VERSION, socketPath: firstGeneration(run.paths).sockets.supervisor });
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

  it('a child that reports another version before promotion makes the start an abandoned one: exit 0, never promoted', async (context) => {
    const run = startEntry(context, { behaviours: { runtime: { readyVersion: `${TEST_VERSION}-other` } } });
    await ready(run);
    expect(await exitOf(run)).toBe(EXIT_OK);
    expect(lastLine(run)).toMatchObject({ msg: 'entry.exit', path: 'close', clean: true, code: EXIT_OK });
    const mismatches = run.supervisorLog().filter((line) => line.msg === 'child.version.mismatch');
    expect(mismatches).toEqual([expect.objectContaining({ child: 'runtime', childVersion: `${TEST_VERSION}-other`, supervisorVersion: TEST_VERSION })]);
    expect(run.supervisorLog().filter((line) => line.msg === 'start.abandoned')).toEqual([expect.objectContaining({ generation: 1, reason: 'version-differs' })]);
    expect(run.supervisorLog().filter((line) => line.msg === 'child.ready' && line['child'] === 'runtime')).toEqual([]);
    expect(fs.existsSync(run.paths.current)).toBe(false);
    expect(run.io.exits).toEqual([EXIT_OK]);
  });

  it('T-I3-45 (15.3 death cases, P7 (c)): a supervisor whose lifeline closes before its children are ready ends without publishing and frees its lock', async (context) => {
    const run = startEntry(context, { lifelineFd: LIFELINE_FD, behaviours: { runtime: { autoReady: false }, gateway: { autoReady: false } } });
    await ready(run);
    await pumpUntil(run.timers, () => run.fake.spawnCount('runtime') >= 1, { maxMs: 10_000, description: 'the runtime to be spawned', realWork: run.realWork });
    expect(run.io.lifelineFds).toEqual([LIFELINE_FD]);
    run.io.endLifeline();
    await exitOf(run);
    expect(run.supervisorLog().filter((line) => line.msg === 'child.ready')).toEqual([]);
    expect(fs.existsSync(run.paths.current)).toBe(false);
    expect((await inspectProcessLock(generationLayout(run.home, 1).locks.supervisor, { mechanism: testKernelLock() })).state).toBe('free');
  });

  it.for([['no flag', false], ['zero', '0'], ['a word', 'two'], ['a signed number', '-1']] as const)('refuses to start with %s for --generation: exit 78 and the settled text', async ([, generationFlag], context) => {
    const run = startEntry(context, { generationFlag });
    expect(await exitOf(run, 5000)).toBe(EXIT_CONFIG);
    expect(run.io.stderrLines().join('\n')).toContain('supervise requires --generation=<N>, a positive whole number');
    expect(run.fake.spawnCount()).toBe(0);
  });

  it('every line of the supervisor log carries the generation', async (context) => {
    const run = startEntry(context);
    await childrenReady(run);
    const lines = run.supervisorLog().filter((line) => typeof line.msg === 'string' && !String(line.msg).startsWith('entry.'));
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((line) => line['generation'] === 1)).toBe(true);
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

  it('SIGTERM during the reap of its own markers exits 0 through close()', async (context) => {
    const run = startEntry(context, {
      markerPorts: {
        reapMarkerDirectory: (options) => new Promise((resolve) => options.signal?.addEventListener('abort', () => resolve({ reaped: 0, kept: 0, unreaped: [] }), { once: true })),
      },
    });
    await ready(run);
    await waitFor(() => run.markers.reapMarkerDirectory.length > 0);
    run.io.signal('SIGTERM');
    expect(await exitOf(run)).toBe(0);
    expect(lastLine(run)).toMatchObject({ msg: 'entry.exit', path: 'close', trigger: 'sigterm', code: 0 });
    expect(run.fake.spawnCount()).toBe(0);
  });

  it('shutdown through runSupervisorEntry exits 0 with trigger request', async (context) => {
    const run = startEntry(context);
    await childrenReady(run);
    run.fake.setBehaviour('runtime', { onTerm: 'ignore' });
    expect((await httpOver(context, firstGeneration(run.paths).sockets.supervisor, 'POST', '/v1/shutdown')).status).toBe(202);
    await waitFor(() => run.fake.latest('runtime').signals.length === 1);
    expect((await httpOver(context, firstGeneration(run.paths).sockets.supervisor, 'POST', '/v1/shutdown')).status).toBe(202);
    await waitFor(() => run.supervisorLog().filter((line) => line.msg === 'entry.shutdown_requested').length === 2);
    run.fake.latest('runtime').exit(0);
    expect(await exitOf(run)).toBe(0);
    expect(lastLine(run)).toMatchObject({ msg: 'entry.exit', path: 'close', trigger: 'request', clean: true, code: 0 });
    expect(run.fake.latest('runtime').signals).toEqual(['SIGTERM']);
    expect(run.fake.latest('gateway').signals).toEqual(['SIGTERM']);
    expect(run.fake.children.flatMap((child) => child.signals)).not.toContain('SIGINT');
  });

  it('a second supervisor of the same generation is an abandoned start: exit 0, no ready line', async (context) => {
    const prepared = prepareHome(context);
    prepareGenerationForTest(prepared.home, 1, TEST_VERSION);
    await startLockHolder(context, firstGeneration(prepared.paths).locks.supervisor);
    const run = startEntry(context, { prepared });
    expect(await exitOf(run, 5000)).toBe(EXIT_OK);
    expect(run.io.stdoutLines()).toEqual([]);
    expect(run.supervisorLog().filter((line) => line.msg === 'start.abandoned')).toEqual([expect.objectContaining({ generation: 1, reason: 'lock-held' })]);
    expect(lastLine(run)).toMatchObject({ msg: 'entry.exit', path: 'close', code: EXIT_OK });
    expect(run.fake.spawnCount()).toBe(0);
  });

  it('a cancel during the supervisor lock acquisition is a startup cancel', async (context) => {
    const prepared = prepareHome(context);
    let io: FakeEntryIo | undefined;
    const run = startEntry(context, { prepared, lockMechanism: cancelOnClaim(firstGeneration(prepared.paths).locks.supervisor, () => io?.signal('SIGTERM')) });
    io = run.io;
    expect(await exitOf(run, 5000)).toBe(1);
    expect(lastLine(run)).toMatchObject({ msg: 'entry.exit', path: 'startup-cancelled', trigger: 'sigterm', code: 1 });
    expect(run.io.stdoutLines()).toEqual([]);
    expect(await inspectProcessLock(firstGeneration(prepared.paths).locks.supervisor, { mechanism: testKernelLock() })).toEqual({ state: 'free' });
  });

  it('a cancel during listenUnix still announces ready and closes gracefully', async (context) => {
    const prepared = prepareHome(context);
    let io: FakeEntryIo | undefined;
    const run = startEntry(context, { prepared, lockMechanism: cancelOnClaim(`${firstGeneration(prepared.paths).sockets.supervisor}.lock`, () => io?.signal('SIGTERM')) });
    io = run.io;
    expect(await exitOf(run, 30_000)).toBe(0);
    expect(run.io.stdoutLines()).toHaveLength(1);
    expect(lastLine(run)).toMatchObject({ msg: 'entry.exit', path: 'close', trigger: 'sigterm', code: 0 });
    expect(run.fake.spawnCount()).toBe(0);
    expect(fs.existsSync(firstGeneration(run.paths).sockets.supervisor)).toBe(false);
    expect(await inspectProcessLock(`${firstGeneration(run.paths).sockets.supervisor}.lock`, { mechanism: testKernelLock() })).toEqual({ state: 'free' });
    expect(await inspectProcessLock(firstGeneration(run.paths).locks.supervisor, { mechanism: testKernelLock() })).toEqual({ state: 'free' });
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
    expect(parseReadyLine(run.io.stdoutLines()[0] ?? '')?.socketPath).toBe(firstGeneration(run.paths).sockets.supervisor);
  });

  it('health.logs.droppedLines follows the sink', async (context) => {
    const run = startEntry(context);
    await ready(run);
    const health = async (): Promise<SupervisorHealth> => JSON.parse((await httpOver(context, firstGeneration(run.paths).sockets.supervisor, 'GET', '/v1/health')).text) as SupervisorHealth;
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
    await pumpUntil(run.timers, () => run.fake.spawnCount('runtime') === 2, { maxMs: 10_000, realWork: run.realWork });
    expect(run.io.logFilePaths).toEqual([run.paths.logFiles.supervisor]);
    const lines = run.supervisorLog();
    expect(lines).toContainEqual(expect.objectContaining({ msg: 'child.stderr', child: 'runtime', childPid: runtime.pid, raw: 'TypeError: boom' }));
    expect(lines).toContainEqual(expect.objectContaining({ msg: 'child.stdout', child: 'runtime', childPid: runtime.pid, raw: 'a stray stdout line' }));
    expect(run.io.logLines(run.paths.logFiles.runtime)).toEqual([]);
    expect(run.io.logLines(run.paths.logFiles.gateway)).toEqual([]);
  });
});
