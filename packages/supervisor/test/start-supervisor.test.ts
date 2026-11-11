import fs from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { ProcessLockHeldError, RUNTIME_DEFAULT_DRAIN_TIMEOUT_MS, parseReadyLine, inspectProcessLock, runtimeMaxCloseMs } from '@momonga/foundation';
import { REAL_PROCESS_TEST_TIMEOUT_MS, createFakeKernelLock, createFakeClock, createFakeTimers, driveFakeTime, prepareGenerationForTest, spawnTracked, waitFor, firstGeneration } from '@momonga/testkit';
import { ORPHAN_POLL_MS, STARTUP_TIMEOUT_MS } from '../src/constants.ts';
import { resolveStartTiming, startSupervisor, supervisorStartBoundMs } from '../src/start-supervisor.ts';
import {
  HARNESS_GENERATION,
  INVALID_SETTINGS_TEXT,
  TEST_VERSION,
  captureLog,
  captureText,
  createFakeSpawn,
  deferred,
  fakeLauncher,
  fakeSettingsWatch,
  httpOver,
  prepareHome,
  pumpUntil,
  recordingMarkerPorts,
  settledFlag,
  startHarness,
  writeMarker,
  writeSettings,
  validSettings,
} from './fixtures/p3-harness.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

describe('startSupervisor', () => {
  it('startup order', async (context) => {
    const watch = fakeSettingsWatch();
    const order: string[] = [];
    let lockPath = '';
    let socketPath = '';
    const seam = ((directory: string, ...rest: unknown[]) => {
      order.push('watch');
      return (watch.watch as unknown as (directory: string, ...rest: unknown[]) => unknown)(directory, ...rest);
    }) as unknown as typeof fs.watch;
    const h = await startHarness(context, {
      order,
      prepare: (_home, paths) => {
        lockPath = firstGeneration(paths).locks.supervisor;
        socketPath = firstGeneration(paths).sockets.supervisor;
        writeMarker(paths, 'runtime-old');
      },
      onStdout: () => order.push(`listening lock=${fs.existsSync(lockPath)} socket=${fs.existsSync(socketPath)}`),
      overrides: { watchSettings: true, settingsWatch: seam },
    });
    await pumpUntil(h.timers, () => order.includes('watch'), { realWork: h.realWork, maxMs: 5000 });
    expect(order.slice(0, 2)).toEqual(['ready', 'listening lock=true socket=true']);
    const firstReap = order.findIndex((entry) => entry === 'findHolders' || entry === 'reapMarkerDirectory');
    const spawns = order.map((entry, index) => (entry.startsWith('spawn:') ? index : -1)).filter((index) => index >= 0);
    expect(firstReap).toBeGreaterThan(1);
    expect(spawns).toHaveLength(2);
    expect(Math.min(...spawns)).toBeGreaterThan(firstReap);
    expect(order.indexOf('watch')).toBeGreaterThan(Math.max(...spawns));
    expect(order.filter((entry) => entry === 'watch')).toHaveLength(1);
    const messages = h.log.messages();
    expect(messages.indexOf('orphans.reaped')).toBeLessThan(messages.indexOf('child.spawn'));
  });

  it('ready line goes to stdout only and carries the control socket', async (context) => {
    const h = await startHarness(context);
    expect(h.stdout.lines()).toHaveLength(1);
    const ready = parseReadyLine(h.stdout.lines()[0] ?? '');
    expect(ready).toEqual({ service: 'supervisor', pid: process.pid, version: TEST_VERSION, socketPath: firstGeneration(h.paths).sockets.supervisor, startedAt: expect.stringMatching(ISO) });
    expect(h.supervisor.ready).toEqual(ready);
    expect(h.health().startedAt).toBe(ready?.startedAt);
  });

  it('startSupervisor resolves before the reap of its own markers ends, and no child spawns before it finished', async (context) => {
    const reap = deferred<{ reaped: number; kept: number }>();
    const h = await startHarness(context, { markerPorts: { reapMarkerDirectory: () => reap.promise } });
    await pumpUntil(h.timers, () => h.markers.calls.reapMarkerDirectory.length === 1, { realWork: h.realWork, maxMs: 5000 });
    await pumpUntil(h.timers, () => true, { realWork: h.realWork, maxMs: 0 });
    expect(h.health().phase).toBe('running');
    expect(h.fake.spawnCount()).toBe(0);
    reap.resolve({ reaped: 1, kept: 0 });
    await pumpUntil(h.timers, () => h.fake.spawnCount() === 2, { realWork: h.realWork, maxMs: 5000 });
    expect(h.health().phase).toBe('running');
  });

  it('a second supervisor of the same generation is an abandoned start: it returns closed, spawns nothing and leaves the lock with its holder', async (context) => {
    const h = await startHarness(context);
    const clock = createFakeClock(0);
    const log = captureLog(clock);
    const spawned = createFakeSpawn();
    const timers = createFakeTimers(clock);
    let settled = false;
    const starting = startSupervisor({
      home: h.home,
      version: TEST_VERSION,
      generation: HARNESS_GENERATION,
      launcher: fakeLauncher,
      spawn: spawned.port,
      clock,
      timers,
      logger: log.logger,
      stdout: captureText(),
      watchSettings: false,
      markerPorts: recordingMarkerPorts().ports,
    }).finally(() => {
      settled = true;
    });
    await driveFakeTime(timers, { done: () => settled, horizonAt: clock.now() + STARTUP_TIMEOUT_MS, description: 'the second supervisor to end its start' });
    const second = await starting;
    expect(second.abandoned).toBe('lock-held');
    expect(await second.closed).toEqual({ clean: true, killed: [], leaked: [] });
    expect(spawned.spawnCount()).toBe(0);
    expect(log.withMsg('start.abandoned')).toMatchObject([{ generation: HARNESS_GENERATION, reason: 'lock-held' }]);
    expect((await inspectProcessLock(firstGeneration(h.paths).locks.supervisor)).state).toBe('held');
  });

  it('a supervisor.sock.lock left behind by a dead holder does not block the start', async (context) => {
    const h = await startHarness(context, {
      prepare: (_home, paths) => {
        fs.mkdirSync(firstGeneration(paths).dir, { recursive: true, mode: 0o700 });
        fs.writeFileSync(`${firstGeneration(paths).sockets.supervisor}.lock`, '999999', { mode: 0o600 });
      },
    });
    expect(fs.statSync(firstGeneration(h.paths).sockets.supervisor).isSocket()).toBe(true);
    expect(fs.readFileSync(`${firstGeneration(h.paths).sockets.supervisor}.lock`, 'utf8').trim()).toBe(String(process.pid));
    expect((await httpOver(context, firstGeneration(h.paths).sockets.supervisor, 'GET', '/v1/health')).status).toBe(200);
  });

  it('startup failure after the lock unwinds and releases the lock', async (context) => {
    const { home, paths } = prepareHome(context);
    writeSettings(home, validSettings());
    prepareGenerationForTest(home, HARNESS_GENERATION, TEST_VERSION);
    fs.writeFileSync(firstGeneration(paths).sockets.supervisor, 'not a socket');
    const clock = createFakeClock(0);
    const stdout = captureText();
    const fake = createFakeSpawn();
    const attempt = startSupervisor({
      home,
      version: TEST_VERSION,
      generation: HARNESS_GENERATION,
      launcher: fakeLauncher,
      spawn: fake.port,
      clock,
      timers: createFakeTimers(clock),
      logger: captureLog(clock).logger,
      stdout,
      watchSettings: false,
      markerPorts: recordingMarkerPorts().ports,
    });
    await expect(attempt).rejects.toThrow(/not a socket/);
    expect(await inspectProcessLock(firstGeneration(paths).locks.supervisor)).toEqual({ state: 'free' });
    expect(await inspectProcessLock(`${firstGeneration(paths).sockets.supervisor}.lock`)).toEqual({ state: 'free' });
    expect(stdout.text()).toBe('');
    expect(fake.spawnCount()).toBe(0);
  });

  it('a started supervisor with invalid settings still announces ready and reports both children held-config', async (context) => {
    const reap = deferred<{ reaped: number; kept: number }>();
    const h = await startHarness(context, { settingsText: INVALID_SETTINGS_TEXT, markerPorts: { reapMarkerDirectory: () => reap.promise } });
    expect(h.stdout.lines()).toHaveLength(1);
    await waitFor(() => h.markers.calls.reapMarkerDirectory.length > 0);
    expect(h.health().children.map((child) => child.state)).toEqual(['pending', 'pending']);
    reap.resolve({ reaped: 0, kept: 0 });
    await pumpUntil(h.timers, () => h.health().children.every((child) => child.state === 'held-config'), { realWork: h.realWork, maxMs: 5000 });
    expect(h.health().children.map((child) => child.state)).toEqual(['held-config', 'held-config']);
    for (const child of h.health().children) {
      expect(child.heldReason).toBeDefined();
      expect(child.heldReason).not.toBe('');
      expect(child.heldReason).not.toMatch(/^child exited 78/);
    }
    expect(h.fake.spawnCount()).toBe(0);
    const held = h.log.withMsg('child.held');
    expect(held.map((line) => [line['child'], line['source']]).sort()).toEqual([
      ['gateway', 'settings'],
      ['runtime', 'settings'],
    ]);
  });

  it('launcher throw backs off', async (context) => {
    const h = await startHarness(context, {
      overrides: { launcher: (role) => (role === 'runtime' ? { command: 'relative/bin/runtime', args: [] } : fakeLauncher(role)) },
    });
    await pumpUntil(h.timers, () => h.child('runtime').state === 'backoff', { realWork: h.realWork, maxMs: 5000 });
    expect(h.child('runtime').lastExit).toMatchObject({ code: null, signal: null, reason: 'spawn-failed' });
    expect(h.fake.spawnCount('gateway')).toBe(1);
    expect(h.fake.spawnCount('runtime')).toBe(0);
    expect(h.health().phase).toBe('running');
    const fatal = settledFlag(h.supervisor.fatal);
    await pumpUntil(h.timers, () => true, { realWork: h.realWork, maxMs: 0 });
    expect(fatal.settled()).toBe(false);
  });

  it('a rejection that no rule covers resolves fatal', async (context) => {
    let explode = false;
    const h = await startHarness(context, {
      overrides: {
        random: () => {
          if (explode) throw new Error('random exploded');
          return 0.5;
        },
      },
    });
    await h.waitForState('runtime', 'ready');
    explode = true;
    const fatal = settledFlag(h.supervisor.fatal);
    h.fake.latest('runtime').exit(1);
    await pumpUntil(h.timers, () => fatal.settled(), { realWork: h.realWork, maxMs: 5000 });
    expect(fatal.value()?.message).toBe('random exploded');
    const failed = h.log.withMsg('supervisor.background_failed');
    expect(failed).toHaveLength(1);
    expect(String(failed[0]?.['source'])).toMatch(/exit/);
    expect(failed[0]?.['err']).toMatchObject({ message: 'random exploded' });
  });

  it('timer callbacks and exit handlers never reject unhandled', async (context) => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => void unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    context.onTestFinished(() => void process.off('unhandledRejection', onUnhandled));
    const lock = createFakeKernelLock({ inheritable: false });
    const holder = spawnTracked(context, 'sleep', ['30']);
    const exploding = {
      ...lock,
      isHeld: async (lockPath: string): Promise<boolean> => {
        if (lockPath.endsWith('gateway.lock')) throw new Error('lock exploded');
        return lock.isHeld(lockPath);
      },
    };
    let explodeRandom = false;
    const h = await startHarness(context, {
      prepare: (_home, paths) => lock.holdExternally(firstGeneration(paths).locks.gateway, holder.pid),
      overrides: {
        lockMechanism: exploding,
        random: () => {
          if (explodeRandom) throw new Error('random exploded');
          return 0.5;
        },
      },
    });
    await h.waitForState('runtime', 'ready');
    await h.waitForState('gateway', 'ready');
    h.fake.latest('gateway').exit(77);
    await pumpUntil(h.timers, () => h.log.withMsg('supervisor.background_failed').length >= 1, { realWork: h.realWork, maxMs: 5000 });
    explodeRandom = true;
    h.fake.latest('runtime').exit(1);
    await pumpUntil(h.timers, () => new Set(h.log.withMsg('supervisor.background_failed').map((line) => String(line['source']))).size >= 2, {
      realWork: h.realWork,
      maxMs: 5000,
    });
    await pumpUntil(h.timers, () => true, { realWork: h.realWork, maxMs: 0 });
    expect(unhandled).toEqual([]);
    const sources = h.log.withMsg('supervisor.background_failed').map((line) => String(line['source']));
    expect(new Set(sources).size).toBe(sources.length);
  });
});

describe('resolveStartTiming', () => {
  const PREDECESSOR = { closeGraceMs: 1, managedServerStopGraceMs: 2, drainTimeoutMs: 7000, mcpCloseGraceMs: 40 };

  it('waits for an unknown predecessor by the bounds of the allowed maxima', () => {
    expect(resolveStartTiming({ predecessorStopValues: undefined })).toEqual({
      startupTimeoutMs: STARTUP_TIMEOUT_MS,
      orphanGraceMs: 508_125,
      orphanReapGraceMs: 208_125,
      orphanPollMs: ORPHAN_POLL_MS,
    });
  });

  it('waits for a predecessor whose stop record it read by the runtime close and the orphan grace of those values', () => {
    expect(resolveStartTiming({ predecessorStopValues: PREDECESSOR })).toEqual({
      startupTimeoutMs: STARTUP_TIMEOUT_MS,
      orphanGraceMs: 7000 + 8050 + 10_000 + 6 * 40 + 10_075,
      orphanReapGraceMs: 8050 + 10_000 + 6 * 40 + 10_075,
      orphanPollMs: ORPHAN_POLL_MS,
    });
  });

  it('takes every injected value in place of its derivation', () => {
    expect(resolveStartTiming({ predecessorStopValues: PREDECESSOR, startupTimeoutMs: 7000, orphanGraceMs: 3000, orphanReapGraceMs: 400, intervals: { orphanPollMs: 50 } })).toEqual({
      startupTimeoutMs: 7000,
      orphanGraceMs: 3000,
      orphanReapGraceMs: 400,
      orphanPollMs: 50,
    });
  });

  it('bounds the start by the startup timeout of the children alone: no start waits for a previous daemon', () => {
    const timing = resolveStartTiming({ predecessorStopValues: PREDECESSOR, orphanGraceMs: 3000 });
    expect(supervisorStartBoundMs(timing)).toBe(timing.startupTimeoutMs);
  });
});
