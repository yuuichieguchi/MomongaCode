import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { canonicalPath, generationLayout } from '@momonga/foundation';
import type { MomongaPaths } from '@momonga/foundation';
import { REAL_PROCESS_TEST_TIMEOUT_MS } from '@momonga/testkit';
import { TEST_VERSION, pump, pumpUntil, quiesce, settledFlag, startHarness } from './fixtures/p3-harness.ts';
import type { Harness, HarnessOptions } from './fixtures/p3-harness.ts';

const FOLD_VERSION = 1;

const startRecordOf = (home: string, generation: number): string => `${generationLayout(canonicalPath(home), generation).dir}/start.json`;

const prepareStart = (generation: number, version: string): NonNullable<HarnessOptions['prepare']> => (home) => {
  fs.mkdirSync(generationLayout(canonicalPath(home), generation).dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(startRecordOf(home, generation), JSON.stringify({ version, foldVersion: FOLD_VERSION }));
};

const asGeneration = (generation: number): NonNullable<HarnessOptions['overrides']> => ({ generation } as unknown as NonNullable<HarnessOptions['overrides']>);

const currentOf = (paths: MomongaPaths): unknown => JSON.parse(fs.readFileSync(paths.current, 'utf8'));

const published = async (h: Harness): Promise<void> => {
  await pumpUntil(h.timers, () => fs.existsSync(h.paths.current), { realWork: h.realWork, maxMs: 5000, description: 'run/current published' });
  await quiesce(h.realWork);
};

const ABANDON_BOUND_MS = 600_000;

const abandonedStart = async (context: Parameters<typeof startHarness>[0], options: HarnessOptions): Promise<{ order: string[]; paths: MomongaPaths; home: string }> => {
  const order: string[] = [];
  let homeOf = '';
  let pathsOf: MomongaPaths | undefined;
  const attempt = await startHarness(context, {
    ...options,
    order,
    prepare: (home, paths) => {
      homeOf = home;
      pathsOf = paths;
      options.prepare?.(home, paths);
    },
  }).then(
    (h) => h,
    () => undefined,
  );
  if (attempt !== undefined) {
    const closed = settledFlag(attempt.supervisor.closed);
    await pumpUntil(attempt.timers, () => closed.settled() || order.some((entry) => entry.startsWith('spawn')), {
      realWork: attempt.realWork,
      maxMs: ABANDON_BOUND_MS,
      description: 'the abandoned supervisor exits or spawns',
    });
  }
  if (pathsOf === undefined) throw new Error('the harness never prepared the home');
  return { order, paths: pathsOf, home: homeOf };
};

describe('a supervisor runs the generation its starter allocated (15.3 S1, S2)', { timeout: REAL_PROCESS_TEST_TIMEOUT_MS }, () => {
  it('learns N from its arguments, gives N to its children, and publishes generation N with its own sockets', async (context) => {
    const h = await startHarness(context, { prepare: prepareStart(2, TEST_VERSION), overrides: asGeneration(2) });
    await published(h);
    const home = canonicalPath(h.home);
    expect(h.fake.latest('runtime').args).toContain('--generation=2');
    expect(h.fake.latest('gateway').args).toContain('--generation=2');
    expect(currentOf(h.paths)).toEqual({ generation: 2, version: TEST_VERSION, sockets: generationLayout(home, 2).sockets });
  });

  it('exits as an abandoned start, spawning no child and publishing nothing, when run/g<N>/ is missing', async (context) => {
    const { order, paths, home } = await abandonedStart(context, { overrides: asGeneration(2) });
    expect(order.filter((entry) => entry.startsWith('spawn'))).toEqual([]);
    expect(fs.existsSync(paths.current)).toBe(false);
    expect(fs.existsSync(generationLayout(canonicalPath(home), 2).locks.supervisor)).toBe(false);
  });

  it('exits as an abandoned start when start.json names another version than the executable', async (context) => {
    const { order, paths } = await abandonedStart(context, { prepare: prepareStart(2, '0.0.1'), overrides: asGeneration(2) });
    expect(order.filter((entry) => entry.startsWith('spawn'))).toEqual([]);
    expect(fs.existsSync(paths.current)).toBe(false);
  });
});

describe('promotion only above run/current (15.3 S4, 15.5, 15.6)', { timeout: REAL_PROCESS_TEST_TIMEOUT_MS }, () => {
  it('a starting generation superseded by a higher run/current never publishes, and exits by itself', async (context) => {
    let before = '';
    const h = await startHarness(context, {
      prepare: (home, paths) => {
        prepareStart(2, TEST_VERSION)(home, paths);
        fs.mkdirSync(paths.run, { recursive: true });
        const sockets = generationLayout(canonicalPath(home), 3).sockets;
        before = `${JSON.stringify({ generation: 3, version: TEST_VERSION, sockets })}\n`;
        fs.writeFileSync(paths.current, before, { mode: 0o600 });
      },
      overrides: asGeneration(2),
    });
    const closed = settledFlag(h.supervisor.closed);
    await pumpUntil(h.timers, () => closed.settled() || fs.readFileSync(h.paths.current, 'utf8') !== before, { realWork: h.realWork, maxMs: 60_000, description: 'the superseded supervisor exits or publishes' });
    expect(fs.readFileSync(h.paths.current, 'utf8')).toBe(before);
    expect(closed.settled()).toBe(true);
  });

  it('a generation numbered above run/current replaces it in one publish', async (context) => {
    const h = await startHarness(context, {
      prepare: (home, paths) => {
        prepareStart(3, TEST_VERSION)(home, paths);
        fs.mkdirSync(paths.run, { recursive: true });
        fs.writeFileSync(paths.current, `${JSON.stringify({ generation: 2, version: TEST_VERSION, sockets: generationLayout(canonicalPath(home), 2).sockets })}\n`, { mode: 0o600 });
      },
      overrides: asGeneration(3),
    });
    await pumpUntil(h.timers, () => fs.existsSync(h.paths.current) && (currentOf(h.paths) as { generation: number }).generation === 3, {
      realWork: h.realWork,
      maxMs: 5000,
      description: 'run/current names generation 3',
    });
    expect(currentOf(h.paths)).toEqual({ generation: 3, version: TEST_VERSION, sockets: generationLayout(canonicalPath(h.home), 3).sockets });
  });
});

describe('a child of another version starts a generation and stops nothing (A7, 15.6)', { timeout: REAL_PROCESS_TEST_TIMEOUT_MS }, () => {
  it('keeps serving, sends no stop, leaves run/current, and allocates the next generation', async (context) => {
    const h = await startHarness(context, { prepare: prepareStart(1, TEST_VERSION), overrides: asGeneration(1) });
    await published(h);
    const current = fs.readFileSync(h.paths.current, 'utf8');
    const stopsBefore = h.order.filter((entry) => entry.startsWith('SIG')).length;
    h.fake.setBehaviour('runtime', { autoReady: false });
    h.fake.latest('runtime').exit(1);
    await pumpUntil(h.timers, () => h.fake.spawnCount('runtime') === 2, { realWork: h.realWork, maxMs: 120_000, description: 'runtime restarted' });
    h.fake.latest('runtime').ready({ version: '0.0.0-replaced' });
    await pump(h.timers, h.realWork, 5000);
    expect(h.health().phase).toBe('running');
    expect(h.order.filter((entry) => entry.startsWith('SIG')).length).toBe(stopsBefore);
    expect(fs.readFileSync(h.paths.current, 'utf8')).toBe(current);
    expect(fs.readFileSync(`${h.paths.run}/generation.counter`, 'utf8').trim()).toBe('2');
    expect(fs.existsSync(startRecordOf(h.home, 2))).toBe(true);
  });
});
