import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ProcessLockHeldError, parseReadyLine } from '@momonga/foundation';
import { createFakeClock, createFakeTimers, spawnTracked, waitFor } from '@momonga/testkit';
import { startSupervisor } from '../src/start-supervisor.ts';
import {
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
  writeLockFile,
  writeMarker,
  writeSettings,
  validSettings,
} from './fixtures/p3-harness.ts';

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
        lockPath = paths.locks.supervisor;
        socketPath = paths.sockets.supervisor;
        writeMarker(paths, 'runtime-old');
      },
      onStdout: () => order.push(`listening lock=${fs.existsSync(lockPath)} socket=${fs.existsSync(socketPath)}`),
      overrides: { watchSettings: true, settingsWatch: seam },
    });
    await pumpUntil(h.timers, () => order.includes('watch'), { stepMs: 50, maxMs: 5000 });
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

  it('ready precedes the first findHolders', async (context) => {
    let socketPath = '';
    const phases: string[] = [];
    const h = await startHarness(context, {
      prepare: (_home, paths) => {
        socketPath = paths.sockets.supervisor;
        writeMarker(paths, 'runtime-old');
      },
      markerPorts: {
        findHolders: async () => {
          if (phases.length === 0) {
            const response = await httpOver(context, socketPath, 'GET', '/v1/health');
            phases.push(String((JSON.parse(response.text) as { phase: string }).phase));
          }
          return [999_999];
        },
      },
    });
    await waitFor(() => phases.length === 1);
    expect(phases).toEqual(['reaping-orphans']);
    expect(h.stdout.lines()).toHaveLength(1);
  });

  it('ready line goes to stdout only and carries the control socket', async (context) => {
    const h = await startHarness(context);
    expect(h.stdout.lines()).toHaveLength(1);
    const ready = parseReadyLine(h.stdout.lines()[0] ?? '');
    expect(ready).toEqual({ service: 'supervisor', pid: process.pid, version: TEST_VERSION, socketPath: h.paths.sockets.supervisor, startedAt: expect.stringMatching(ISO) });
    expect(h.supervisor.ready).toEqual(ready);
    expect(h.health().startedAt).toBe(ready?.startedAt);
  });

  it('startSupervisor resolves before the reap ends, and no child spawns before it finished', async (context) => {
    const reap = deferred<{ reaped: number; kept: number }>();
    const h = await startHarness(context, {
      prepare: (_home, paths) => void writeMarker(paths, 'runtime-old'),
      markerPorts: { findHolders: async () => [999_999], reapMarkerDirectory: () => reap.promise },
      overrides: { orphanGraceMs: 250 },
    });
    await pumpUntil(h.timers, () => h.markers.calls.reapMarkerDirectory.length === 1, { stepMs: 250, maxMs: 5000 });
    await pumpUntil(h.timers, () => true, { maxMs: 0 });
    expect(h.health().phase).toBe('reaping-orphans');
    expect(h.fake.spawnCount()).toBe(0);
    reap.resolve({ reaped: 1, kept: 0 });
    await pumpUntil(h.timers, () => h.fake.spawnCount() === 2, { stepMs: 50, maxMs: 5000 });
    expect(h.health().phase).toBe('running');
  });

  it('second supervisor on the same home is refused with the supervisor lock', async (context) => {
    const h = await startHarness(context);
    const clock = createFakeClock(0);
    const second = startSupervisor({
      home: h.home,
      version: TEST_VERSION,
      launcher: fakeLauncher,
      spawn: createFakeSpawn().port,
      clock,
      timers: createFakeTimers(clock),
      logger: captureLog(clock).logger,
      stdout: captureText(),
      watchSettings: false,
      markerPorts: recordingMarkerPorts().ports,
    });
    const error = await second.then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ProcessLockHeldError);
    expect((error as ProcessLockHeldError).lockPath).toBe(h.paths.locks.supervisor);
  });

  it('ghost supervisor.sock.lock is taken over', async (context) => {
    const holder = spawnTracked(context, 'sleep', ['30']);
    const probed: number[] = [];
    const h = await startHarness(context, {
      prepare: (_home, paths) => writeLockFile(`${paths.sockets.supervisor}.lock`, holder.pid, Date.now() - 3_600_000),
      overrides: {
        startTimeOf: async (pid) => {
          probed.push(pid);
          return Date.now();
        },
      },
    });
    expect(probed).toContain(holder.pid);
    expect(fs.statSync(h.paths.sockets.supervisor).isSocket()).toBe(true);
    expect(fs.readFileSync(`${h.paths.sockets.supervisor}.lock`, 'utf8').trim()).toBe(String(process.pid));
    expect((await httpOver(context, h.paths.sockets.supervisor, 'GET', '/v1/health')).status).toBe(200);
  });

  it('startup failure after the lock unwinds and releases the lock', async (context) => {
    const { home, paths } = prepareHome(context);
    writeSettings(home, validSettings());
    fs.mkdirSync(paths.run, { recursive: true, mode: 0o700 });
    fs.writeFileSync(paths.sockets.supervisor, 'not a socket');
    const clock = createFakeClock(0);
    const stdout = captureText();
    const fake = createFakeSpawn();
    const attempt = startSupervisor({
      home,
      version: TEST_VERSION,
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
    expect(fs.existsSync(paths.locks.supervisor)).toBe(false);
    expect(fs.existsSync(`${paths.sockets.supervisor}.lock`)).toBe(false);
    expect(stdout.text()).toBe('');
    expect(fake.spawnCount()).toBe(0);
  });

  it('a started supervisor with invalid settings still announces ready and reports both children held-config', async (context) => {
    let holding = true;
    const h = await startHarness(context, {
      settingsText: INVALID_SETTINGS_TEXT,
      prepare: (_home, paths) => void writeMarker(paths, 'runtime-old'),
      markerPorts: { findHolders: async () => (holding ? [999_999] : []) },
      overrides: { orphanGraceMs: 60_000 },
    });
    expect(h.stdout.lines()).toHaveLength(1);
    await waitFor(() => h.markers.calls.findHolders.length > 0);
    expect(h.health().children.map((child) => child.state)).toEqual(['pending', 'pending']);
    holding = false;
    await pumpUntil(h.timers, () => h.health().phase === 'running', { stepMs: 250, maxMs: 5000 });
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
    await pumpUntil(h.timers, () => h.child('runtime').state === 'backoff', { stepMs: 50, maxMs: 5000 });
    expect(h.child('runtime').lastExit).toMatchObject({ code: null, signal: null, reason: 'spawn-failed' });
    expect(h.fake.spawnCount('gateway')).toBe(1);
    expect(h.fake.spawnCount('runtime')).toBe(0);
    expect(h.health().phase).toBe('running');
    const fatal = settledFlag(h.supervisor.fatal);
    await pumpUntil(h.timers, () => true, { maxMs: 0 });
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
    await pumpUntil(h.timers, () => fatal.settled(), { stepMs: 50, maxMs: 5000 });
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
    const holder = spawnTracked(context, 'sleep', ['30']);
    let explodeRandom = false;
    const h = await startHarness(context, {
      prepare: (_home, paths) => writeLockFile(paths.locks.gateway, holder.pid),
      overrides: {
        startTimeOf: async (pid) => {
          if (pid === holder.pid) throw new Error('ps exploded');
          return undefined;
        },
        random: () => {
          if (explodeRandom) throw new Error('random exploded');
          return 0.5;
        },
      },
    });
    await h.waitForState('runtime', 'ready');
    await h.waitForState('gateway', 'ready');
    h.fake.latest('gateway').exit(75);
    await pumpUntil(h.timers, () => h.log.withMsg('supervisor.background_failed').length >= 1, { stepMs: 50, maxMs: 5000 });
    explodeRandom = true;
    h.fake.latest('runtime').exit(1);
    await pumpUntil(h.timers, () => new Set(h.log.withMsg('supervisor.background_failed').map((line) => String(line['source']))).size >= 2, {
      stepMs: 50,
      maxMs: 5000,
    });
    await pumpUntil(h.timers, () => true, { maxMs: 0 });
    expect(unhandled).toEqual([]);
    const sources = h.log.withMsg('supervisor.background_failed').map((line) => String(line['source']));
    expect(new Set(sources).size).toBe(sources.length);
  });
});
