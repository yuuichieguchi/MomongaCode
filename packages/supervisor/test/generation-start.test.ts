import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { EXIT_RETIRED, GENERATION_POLL_INTERVAL_MS, STARTUP_TIMEOUT_MS, generationLayout, inspectProcessLock, syncPaths } from '@momonga/foundation';
import type { MomongaPaths } from '@momonga/foundation';
import { REAL_PROCESS_TEST_TIMEOUT_MS, createFakeKernelLock, prepareGenerationForTest, testKernelLock } from '@momonga/testkit';
import { TEST_VERSION, pump, pumpUntil, quiesce, settledFlag, startHarness } from './fixtures/p3-harness.ts';
import type { Harness } from './fixtures/p3-harness.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const FOLD_VERSION = 1;

const layoutOf = (home: string, generation: number) => generationLayout(syncPaths.canonicalPath(home), generation);

const currentOf = (paths: MomongaPaths): unknown => JSON.parse(fs.readFileSync(paths.current, 'utf8'));

const writeCurrent = (home: string, paths: MomongaPaths, generation: number, version = TEST_VERSION): string => {
  const text = `${JSON.stringify({ generation, version, sockets: layoutOf(home, generation).sockets })}\n`;
  fs.writeFileSync(paths.current, text, { mode: 0o600 });
  return text;
};

const published = async (h: Harness, generation: number): Promise<void> => {
  await pumpUntil(h.timers, () => fs.existsSync(h.paths.current) && (currentOf(h.paths) as { generation: number }).generation === generation && h.supervisor.role() === 'serving', {
    realWork: h.realWork,
    maxMs: 5000,
    description: `run/current names generation ${generation}`,
  });
  await quiesce(h.realWork);
};

const signalsIn = (h: Harness): string[] => h.order.filter((entry) => entry.startsWith('SIG') || entry.startsWith('kill'));

const closedOf = (h: Harness) => settledFlag(h.supervisor.closed);

describe('a supervisor runs the generation its starter allocated (15.3 S1, S2)', () => {
  it('learns N from its arguments, gives N to its children, and publishes generation N with its own sockets', async (context) => {
    const h = await startHarness(context, { generation: 2 });
    await published(h, 2);
    expect(h.fake.latest('runtime').args).toContain('--generation=2');
    expect(h.fake.latest('gateway').args).toContain('--generation=2');
    expect(currentOf(h.paths)).toEqual({ generation: 2, version: TEST_VERSION, sockets: layoutOf(h.home, 2).sockets });
    expect(h.health()).toMatchObject({ generation: 2, role: 'serving', phase: 'running' });
    expect(h.log.withMsg('generation.promoted')).toMatchObject([{ generation: 2, version: TEST_VERSION }]);
  });

  it.for([
    ['run/g<N>/ is missing', 'directory-missing', (home: string) => fs.rmSync(layoutOf(home, 2).dir, { recursive: true })],
    ['the marker directory of the generation is missing', 'directory-missing', (home: string) => fs.rmSync(layoutOf(home, 2).markers, { recursive: true })],
    ['start.json is missing', 'record-missing', (home: string) => fs.rmSync(layoutOf(home, 2).startRecord)],
    ['start.json cannot be read', 'record-unreadable', (home: string) => fs.writeFileSync(layoutOf(home, 2).startRecord, '{')],
    ['start.json names another version than the executable', 'version-differs', (home: string) => fs.writeFileSync(layoutOf(home, 2).startRecord, JSON.stringify({ version: '0.0.1', foldVersion: FOLD_VERSION }))],
  ] as const)('exits as an abandoned start, spawning no child and publishing nothing, when %s', async ([, reason, spoil], context) => {
    const h = await startHarness(context, { generation: 2, prepare: (home) => spoil(home) });
    expect(h.supervisor.abandoned).toBe(reason);
    expect(await h.supervisor.closed).toEqual({ clean: true, killed: [], leaked: [] });
    expect(h.fake.spawnCount()).toBe(0);
    expect(fs.existsSync(h.paths.current)).toBe(false);
    expect(h.log.withMsg('start.abandoned')).toMatchObject([{ generation: 2, reason }]);
    expect((await inspectProcessLock(layoutOf(h.home, 2).locks.supervisor, { mechanism: testKernelLock() })).state).toBe('free');
    expect(h.stdout.lines()).toEqual([]);
  });

  it('exits as an abandoned start when another process holds supervisor.lock, and leaves the lock with it', async (context) => {
    const lock = createFakeKernelLock({ inheritable: false });
    const h = await startHarness(context, { generation: 2, prepare: (home) => lock.holdExternally(layoutOf(home, 2).locks.supervisor, 4300), overrides: { lockMechanism: lock } });
    expect(h.supervisor.abandoned).toBe('lock-held');
    expect(h.fake.spawnCount()).toBe(0);
    expect(lock.isHeldBy(layoutOf(h.home, 2).locks.supervisor)).toBe('external');
    expect(lock.isHeldBy(h.paths.generationLock)).toBeUndefined();
  });
});

describe('promotion only above run/current (15.3 S4, 15.5, 15.6)', () => {
  it('a starting generation superseded by a higher run/current never publishes, and exits by itself with start.superseded', async (context) => {
    let before = '';
    const h = await startHarness(context, { generation: 2, prepare: (home, paths) => void (before = writeCurrent(home, paths, 3)) });
    const closed = closedOf(h);
    await pumpUntil(h.timers, () => closed.settled(), { realWork: h.realWork, maxMs: 60_000, description: 'the superseded supervisor exits' });
    expect(fs.readFileSync(h.paths.current, 'utf8')).toBe(before);
    expect(closed.value()).toMatchObject({ clean: true });
    expect(h.log.withMsg('start.superseded')).toMatchObject([{ generation: 2, current: 3 }]);
    expect(h.supervisor.role()).toBe('starting');
  });

  it('a generation numbered above run/current replaces it in one publish', async (context) => {
    const h = await startHarness(context, { generation: 3, prepare: (home, paths) => void writeCurrent(home, paths, 2) });
    await published(h, 3);
    expect(currentOf(h.paths)).toEqual({ generation: 3, version: TEST_VERSION, sockets: layoutOf(h.home, 3).sockets });
  });

  it('retries the promotion at each tick while run/generation.lock is busy, and publishes once it is free', async (context) => {
    const lock = createFakeKernelLock({ inheritable: false });
    const h = await startHarness(context, { behaviours: { runtime: { autoReady: false } }, overrides: { lockMechanism: lock } });
    await h.waitForState('gateway', 'ready');
    lock.holdExternally(h.paths.generationLock, 4700);
    h.fake.latest('runtime').ready();
    await h.waitForState('runtime', 'ready');
    await pump(h.timers, h.realWork, 3 * GENERATION_POLL_INTERVAL_MS);
    expect(fs.existsSync(h.paths.current)).toBe(false);
    expect(h.supervisor.role()).toBe('starting');
    lock.releaseExternally(h.paths.generationLock);
    await pump(h.timers, h.realWork, GENERATION_POLL_INTERVAL_MS);
    await published(h, 1);
  });

  it('a start whose child reports progress past the start-up bound in total is promoted, and its health shows the progress', async (context) => {
    const h = await startHarness(context, { behaviours: { runtime: { autoReady: false } } });
    await h.waitForState('gateway', 'ready');
    const child = h.fake.latest('runtime');
    const PROGRESS_EVERY_MS = STARTUP_TIMEOUT_MS - 10_000;
    let seen: string | undefined;
    for (let step = 0; step < 3; step += 1) {
      await pump(h.timers, h.realWork, PROGRESS_EVERY_MS);
      child.writeStdout(JSON.stringify({ event: 'progress', service: 'runtime', pid: child.pid, step: `step-${step}` }));
      await pumpUntil(h.timers, () => h.child('runtime').progressAt !== seen && h.child('runtime').progressAt !== undefined, { realWork: h.realWork, maxMs: 1000, description: 'the progress is in the health' });
      seen = h.child('runtime').progressAt;
    }
    expect(h.log.withMsg('start.unpromoted')).toEqual([]);
    expect(h.child('runtime').state).toBe('starting');
    child.ready();
    await published(h, 1);
  });

  it('gives up at the start-up bound, counted from its start, when it was never promoted: exits by itself, keeps its directory, publishes nothing', async (context) => {
    const lock = createFakeKernelLock({ inheritable: false });
    const h = await startHarness(context, { behaviours: { runtime: { autoReady: false } }, overrides: { lockMechanism: lock } });
    await h.waitForState('gateway', 'ready');
    lock.holdExternally(h.paths.generationLock, 4700);
    h.fake.latest('runtime').ready();
    const closed = closedOf(h);
    await pumpUntil(h.timers, () => closed.settled(), { realWork: h.realWork, maxMs: STARTUP_TIMEOUT_MS + 120_000, description: 'the unpromoted supervisor exits' });
    expect(h.log.withMsg('start.unpromoted')).toMatchObject([{ generation: 1, reason: 'startup-bound' }]);
    expect(h.log.withMsg('start.unpromoted')[0]?.ts).toBe(new Date(Date.parse('2026-01-01T00:00:00.000Z') + STARTUP_TIMEOUT_MS).toISOString());
    expect(fs.existsSync(h.paths.current)).toBe(false);
    expect(fs.existsSync(layoutOf(h.home, 1).dir)).toBe(true);
    expect(closed.value()).toMatchObject({ clean: true });
  });
});

describe('the retiring supervisor (15.5, 15.6, P6, 20.1)', () => {
  const serving = async (context: Parameters<typeof startHarness>[0]): Promise<Harness> => {
    const h = await startHarness(context);
    await published(h, 1);
    return h;
  };

  const retire = async (h: Harness): Promise<string> => {
    prepareGenerationForTest(h.home, 2, TEST_VERSION);
    const text = writeCurrent(h.home, h.paths, 2);
    await pump(h.timers, h.realWork, GENERATION_POLL_INTERVAL_MS);
    return text;
  };

  it('knows it is retiring one poll after run/current names a newer generation, not before', async (context) => {
    const h = await serving(context);
    prepareGenerationForTest(h.home, 2, TEST_VERSION);
    writeCurrent(h.home, h.paths, 2);
    expect(h.supervisor.role()).toBe('serving');
    await pump(h.timers, h.realWork, GENERATION_POLL_INTERVAL_MS);
    expect(h.supervisor.role()).toBe('retiring');
    expect(h.health()).toMatchObject({ role: 'retiring', phase: 'running' });
    expect(h.log.withMsg('generation.retiring')).toMatchObject([{ generation: 1, current: 2 }]);
    await pump(h.timers, h.realWork, 5 * GENERATION_POLL_INTERVAL_MS);
    expect(h.log.withMsg('generation.retiring')).toHaveLength(1);
  });

  it('exits when both children ended with the retire code, releases supervisor.lock, and stops nothing before', async (context) => {
    const h = await serving(context);
    await retire(h);
    const closed = closedOf(h);
    h.fake.latest('runtime').exit(EXIT_RETIRED);
    await pump(h.timers, h.realWork, 3 * GENERATION_POLL_INTERVAL_MS);
    expect(closed.settled()).toBe(false);
    expect(h.child('runtime')).toMatchObject({ state: 'stopped', lastExit: { code: EXIT_RETIRED, reason: 'retired' } });
    expect(h.fake.spawnCount('runtime')).toBe(1);
    h.fake.latest('gateway').exit(EXIT_RETIRED);
    await pumpUntil(h.timers, () => closed.settled(), { realWork: h.realWork, maxMs: 60_000, description: 'the retired supervisor exits' });
    expect(closed.value()).toEqual({ clean: true, killed: [], leaked: [] });
    expect(signalsIn(h)).toEqual([]);
    expect(h.fake.spawnCount()).toBe(2);
    expect((await inspectProcessLock(layoutOf(h.home, 1).locks.supervisor, { mechanism: testKernelLock() })).state).toBe('free');
    expect(h.log.withMsg('generation.ended')).toMatchObject([{ generation: 1 }]);
  });

  it('a child that ends with the retire code before the supervisor polled makes the supervisor retiring at once', async (context) => {
    const h = await serving(context);
    h.fake.latest('runtime').exit(EXIT_RETIRED);
    await pumpUntil(h.timers, () => h.supervisor.role() === 'retiring', { realWork: h.realWork, maxMs: 500, description: 'retiring from the child exit' });
    expect(h.fake.spawnCount('runtime')).toBe(1);
  });

  it('never restarts a child of a retiring generation that exits for another reason', async (context) => {
    const h = await serving(context);
    await retire(h);
    h.fake.latest('runtime').exit(1);
    await pump(h.timers, h.realWork, 120_000);
    expect(h.fake.spawnCount('runtime')).toBe(1);
    expect(h.child('runtime')).toMatchObject({ state: 'stopped', lastExit: { code: 1, reason: 'failure' } });
  });

  it('never publishes again and stays retiring when the generation run/current names dies', async (context) => {
    const h = await serving(context);
    const text = await retire(h);
    await pump(h.timers, h.realWork, 10 * GENERATION_POLL_INTERVAL_MS);
    expect(fs.readFileSync(h.paths.current, 'utf8')).toBe(text);
    expect(h.supervisor.role()).toBe('retiring');
  });

  it('keeps its belief when run/current cannot be read', async (context) => {
    const h = await serving(context);
    fs.writeFileSync(h.paths.current, 'not json');
    await pump(h.timers, h.realWork, 3 * GENERATION_POLL_INTERVAL_MS);
    expect(h.supervisor.role()).toBe('serving');
    expect(h.health().phase).toBe('running');
  });

  it('runs the reaper pass in the background after promotion and at the ticks while serving, one at a time, and none while retiring', async (context) => {
    let running = 0;
    let most = 0;
    let passes = 0;
    const h = await startHarness(context, {
      overrides: {
        reaperPass: async () => {
          running += 1;
          most = Math.max(most, running);
          passes += 1;
          await Promise.resolve();
          running -= 1;
        },
      },
    });
    await published(h, 1);
    expect(passes).toBeGreaterThanOrEqual(1);
    await pump(h.timers, h.realWork, 3 * GENERATION_POLL_INTERVAL_MS);
    expect(passes).toBeGreaterThanOrEqual(3);
    expect(most).toBe(1);
    await retire(h);
    const atRetire = passes;
    await pump(h.timers, h.realWork, 3 * GENERATION_POLL_INTERVAL_MS);
    expect(passes).toBe(atRetire);
  });
});

describe('a child of another version (A7, 15.6, 15.14 P4, 20.11, 20.12)', () => {
  const counterOf = (h: Harness): string => fs.readFileSync(h.paths.generationCounter, 'utf8');

  const restartedWith = async (h: Harness, role: 'runtime' | 'gateway', version: string): Promise<void> => {
    const spawned = h.fake.spawnCount(role);
    h.fake.setBehaviour(role, { autoReady: false });
    h.fake.latest(role).exit(1);
    await pumpUntil(h.timers, () => h.fake.spawnCount(role) === spawned + 1, { realWork: h.realWork, maxMs: 120_000, description: `${role} restarted` });
    h.fake.latest(role).ready({ version });
    await h.waitForState(role, 'held-version');
  };

  const servingWithCounter = async (context: Parameters<typeof startHarness>[0]): Promise<Harness> => {
    const h = await startHarness(context, { prepare: (_home, paths) => fs.writeFileSync(paths.generationCounter, '1\n') });
    await published(h, 1);
    return h;
  };

  it('a newer installed version starts a generation of that version beside it: keeps serving, leaves run/current, holds the successor', async (context) => {
    const h = await servingWithCounter(context);
    const current = fs.readFileSync(h.paths.current, 'utf8');
    await restartedWith(h, 'runtime', '9.9.10-replaced');
    await pumpUntil(h.timers, () => h.successorLaunches.length === 1, { realWork: h.realWork, maxMs: 5000, description: 'the successor is launched' });
    expect(h.health().phase).toBe('running');
    expect(h.supervisor.role()).toBe('serving');
    expect(h.child('runtime')).toMatchObject({ state: 'held-version', lastExit: { reason: 'version-mismatch' } });
    expect(h.fake.latest('gateway').signals).toEqual([]);
    expect(fs.readFileSync(h.paths.current, 'utf8')).toBe(current);
    expect(counterOf(h)).toBe('2\n');
    expect(JSON.parse(fs.readFileSync(layoutOf(h.home, 2).startRecord, 'utf8'))).toEqual({ version: '9.9.10-replaced', foldVersion: FOLD_VERSION });
    expect(h.successorLaunches).toEqual([2]);
    expect(await testKernelLock().isHeld(layoutOf(h.home, 2).startingLock)).toBe(true);
    expect(h.log.withMsg('generation.successor')).toMatchObject([{ generation: 1, successor: 2, version: '9.9.10-replaced', outcome: 'started' }]);
    await pump(h.timers, h.realWork, 120_000);
    expect(h.fake.spawnCount('runtime')).toBe(2);
  });

  it('a successor whose spawn fails after the launch returned is a spawn-failed successor like one whose launch throws: its start is released and the generation keeps serving', async (context) => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => void unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    context.onTestFinished(() => void process.off('unhandledRejection', onUnhandled));
    const launched: number[] = [];
    const h = await startHarness(context, {
      prepare: (_home, paths) => fs.writeFileSync(paths.generationCounter, '1\n'),
      overrides: {
        successorLauncher: {
          launch: (generation) => {
            launched.push(generation);
            return { pid: undefined, exit: Promise.reject(Object.assign(new Error('spawn /gone/momonga ENOENT'), { code: 'ENOENT' })) };
          },
        },
      },
    });
    await published(h, 1);
    const fatal = settledFlag(h.supervisor.fatal);
    await restartedWith(h, 'runtime', '9.9.10-replaced');
    await pumpUntil(h.timers, () => h.log.withMsg('generation.successor').some((line) => line['outcome'] === 'spawn-failed'), { realWork: h.realWork, maxMs: 5000, description: 'the failed spawn of the successor to be reported' });
    await quiesce(h.realWork);
    expect(launched).toEqual([2]);
    expect(h.log.withMsg('generation.successor').at(-1)).toMatchObject({ generation: 1, successor: 2, version: '9.9.10-replaced', outcome: 'spawn-failed', level: 'warn' });
    expect(h.log.withMsg('supervisor.background_transient')).toMatchObject([{ source: 'successor', err: { message: 'spawn /gone/momonga ENOENT' } }]);
    expect(await testKernelLock().isHeld(layoutOf(h.home, 2).startingLock)).toBe(false);
    expect(h.supervisor.role()).toBe('serving');
    expect(h.health().phase).toBe('running');
    expect(fatal.settled()).toBe(false);
    expect(unhandled).toEqual([]);
  });

  it('releases the starting lock of its successor at the start-up bound when no supervisor claimed it', async (context) => {
    const h = await servingWithCounter(context);
    await restartedWith(h, 'runtime', '9.9.10-replaced');
    await pumpUntil(h.timers, () => h.successorLaunches.length === 1, { realWork: h.realWork, maxMs: 5000 });
    await pump(h.timers, h.realWork, STARTUP_TIMEOUT_MS + GENERATION_POLL_INTERVAL_MS);
    expect(await testKernelLock().isHeld(layoutOf(h.home, 2).startingLock)).toBe(false);
  });

  it('an older installed version is refused below the floor: nothing is allocated, the child is held and never spawned again', async (context) => {
    const h = await servingWithCounter(context);
    await restartedWith(h, 'runtime', '9.9.8-replaced');
    await pump(h.timers, h.realWork, 120_000);
    expect(counterOf(h)).toBe('1\n');
    expect(fs.existsSync(layoutOf(h.home, 2).dir)).toBe(false);
    expect(h.successorLaunches).toEqual([]);
    expect(h.health().phase).toBe('running');
    expect(h.child('runtime').state).toBe('held-version');
    expect(h.fake.spawnCount('runtime')).toBe(2);
    expect(h.log.withMsg('generation.successor')).toMatchObject([{ outcome: 'below-floor', version: '9.9.8-replaced' }]);
  });

  it('asks once per installed version: a second child of the same version allocates nothing more', async (context) => {
    const h = await servingWithCounter(context);
    await restartedWith(h, 'runtime', '9.9.10-replaced');
    await pumpUntil(h.timers, () => h.successorLaunches.length === 1, { realWork: h.realWork, maxMs: 5000 });
    await restartedWith(h, 'gateway', '9.9.10-replaced');
    await pump(h.timers, h.realWork, 5000);
    expect(h.successorLaunches).toEqual([2]);
    expect(counterOf(h)).toBe('2\n');
  });

  it('joins a start of at least the installed version instead of allocating', async (context) => {
    const h = await servingWithCounter(context);
    prepareGenerationForTest(h.home, 2, '9.9.10-replaced');
    fs.writeFileSync(h.paths.generationCounter, '2\n');
    const starter = await testKernelLock().claim(layoutOf(h.home, 2).startingLock);
    if (starter.kind !== 'claimed') throw new Error('the starting lock of generation 2 was not free');
    try {
      await restartedWith(h, 'runtime', '9.9.10-replaced');
      await pumpUntil(h.timers, () => h.log.withMsg('generation.successor').length === 1, { realWork: h.realWork, maxMs: 5000 });
      expect(h.log.withMsg('generation.successor')).toMatchObject([{ successor: 2, outcome: 'joined' }]);
      expect(h.successorLaunches).toEqual([]);
      expect(counterOf(h)).toBe('2\n');
      expect(fs.existsSync(path.join(h.paths.run, 'g3'))).toBe(false);
    } finally {
      starter.lock.release();
    }
  });
});
