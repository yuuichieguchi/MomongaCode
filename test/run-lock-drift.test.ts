import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { lockPathNameOf, sqliteFileLock } from '@momonga/foundation';
import { HEAVY_STEPS, LIGHT_STEPS, acquireRunLock } from '../scripts/support/run-lock.ts';
import { createTempRoot, removeTempRoot } from '../scripts/support/temp.ts';

const specPath = path.resolve(import.meta.dirname, '..', 'specs', 'tla', 'RunLock.tla');
const spec = fs.readFileSync(specPath, 'utf8');

const operatorOf = (prefix: string, step: string): string => `${prefix}${step.charAt(0).toUpperCase()}${step.slice(1)}`;

const positionOf = (name: string): number => spec.search(new RegExp(`^${name}(\\([^)]*\\))? ==`, 'm'));

const definitionBody = (name: string): string => {
  const start = positionOf(name);
  if (start < 0) throw new Error(`${name} is not defined in ${specPath}`);
  const rest = spec.slice(start);
  const next = rest.search(/\n\S/);
  return next < 0 ? rest : rest.slice(0, next + 1);
};

describe('the run lock steps in the code are the actions of RunLock.tla', () => {
  it('TB53 names the modelled steps in the order of the model', () => {
    const light = LIGHT_STEPS.map((step) => operatorOf('L', step));
    const heavy = HEAVY_STEPS.map((step) => operatorOf('H', step));

    expect([...light, ...heavy]).toEqual(['LClaimOwn', 'LCheckHeavy', 'HClaimHeavy', 'HScanOne', 'HDecide']);
    for (const steps of [light, heavy]) {
      const positions = steps.map(positionOf);
      expect(positions.every((position) => position >= 0)).toBe(true);
      expect(positions).toEqual([...positions].sort((left, right) => left - right));
    }
  });

  it('the arrival queue is modelled as built: a busy run of either class records its arrival, a heavy checks the queue before it claims heavy, a light looks at heavy and then at earlier heavy waiters, and a run releases its waiter when it starts', () => {
    expect(positionOf('HCheckQueue')).toBeLessThan(positionOf('HClaimHeavy'));
    expect(definitionBody('HStep')).toMatch(/^HStep\(h\) == HCheckQueue\(h\) \\\/ HClaimHeavy\(h\)/);
    expect(definitionBody('Record')).toContain('/\\ p \\in Waiters');
    expect(definitionBody('Record')).toContain("next' = IF next < Inf THEN next + 1 ELSE next");
    expect(definitionBody('Retry')).toContain('/\\ arr[p] # 0');
    expect(definitionBody('Earlier')).toContain('{q \\in classes \\ {p} : Seen(q) /\\ ArrOf(q) < ArrOf(p)}');
    expect(definitionBody('LightAhead')).toContain('ELSE Earlier(l, Heavies)');
    expect(definitionBody('HCheckQueue')).toContain('IF Earlier(h, Procs) # {}');
    const check = definitionBody('LCheckHeavy');
    expect(check.indexOf('LightAhead(l) # {}')).toBeGreaterThan(check.indexOf('heavyHeld # None'));
    expect(definitionBody('HDecide')).toContain('Released(h)');
    expect(definitionBody('Crash')).toContain("waiting' =");
    expect(definitionBody('Crash')).toContain('waitFile');
  });
});

describe('scripts/support/run-lock.ts follows the heavy waiter of RunLock.tla', () => {
  let root = '';
  let dir = '';
  let proofDir = '';
  const releases: Array<() => Promise<void> | void> = [];

  beforeEach(() => {
    root = createTempRoot();
    dir = path.join(root, 'state', 'run-lock');
    proofDir = path.join(root, 'state', 'run-lock-proof');
  });

  afterEach(async () => {
    for (const release of releases.splice(0).reverse()) await release();
    removeTempRoot(root);
  });

  type Request = Parameters<typeof acquireRunLock>[0];

  const request = (over: Partial<Request>): Request => ({
    runClass: 'light',
    dir,
    proofDir,
    command: 'cmd',
    cwd: '/w',
    pid: 1,
    env: {},
    waitSeconds: 0,
    signal: new AbortController().signal,
    say: () => undefined,
    monotonic: () => 0,
    sleep: async () => undefined,
    pollMs: 1000,
    mechanism: sqliteFileLock,
    ...over,
  });

  const waiterUnits = (): string[] => [...new Set(fs.readdirSync(dir).map((name) => lockPathNameOf(sqliteFileLock, name)))].filter((name) => /^waiting\.\d{16}\.heavy\.[0-9a-f]{16}$/.test(name));

  it('HRecordWait and LightsOutWhileWaiting: while the heavy waits, its unit exists and a new light run is refused naming it; WaiterReleased: the unit is gone once the heavy runs', async () => {
    const holder = await acquireRunLock(request({ pid: 10, command: 'holder' }));
    if (holder.kind !== 'acquired') throw new Error(`the first light run was ${holder.kind}`);
    const during: Array<{ units: number; late: string }> = [];
    const heavy = await acquireRunLock(
      request({
        runClass: 'heavy',
        pid: 20,
        command: 'heavy',
        waitSeconds: 60,
        sleep: async () => {
          const late = await acquireRunLock(request({ pid: 30, command: 'late' }));
          during.push({ units: waiterUnits().length, late: late.kind === 'refused' ? late.message : late.kind });
          if (late.kind === 'acquired') await late.release();
          await holder.release();
        },
      }),
    );
    if (heavy.kind === 'acquired') releases.push(() => heavy.release());

    expect(during).toHaveLength(1);
    expect(during[0]?.units).toBe(1);
    expect(during[0]?.late).toMatch(/^run-lock: light run refused: held by waiting heavy pid 20 /);
    expect(heavy.kind).toBe('acquired');
    expect(waiterUnits()).toEqual([]);
  });

  it('NoDeadWaiterBlocks and WaiterFileOnlyOfDead: the unit of a waiter whose process died keeps no light run out, and that light attempt removes it', async () => {
    fs.mkdirSync(dir, { recursive: true });
    const hex = 'eeeeeeeeeeeeeeee';
    const claimed = await sqliteFileLock.claim(path.join(dir, `waiting.0000000000000000.heavy.${hex}`));
    if (claimed.kind !== 'claimed') throw new Error('the waiter unit was not free');
    claimed.lock.writeHolder(hex);
    claimed.lock.release();

    const light = await acquireRunLock(request({ pid: 40 }));
    if (light.kind === 'acquired') releases.push(() => light.release());

    expect(light.kind).toBe('acquired');
    expect(waiterUnits()).toEqual([]);
  });

  it('GiveUp releases the waiter: a heavy run that waits out leaves no heavy-waiting unit', async () => {
    const holder = await acquireRunLock(request({ pid: 50 }));
    if (holder.kind !== 'acquired') throw new Error(`the light run was ${holder.kind}`);
    releases.push(() => holder.release());
    let now = 0;
    const heavy = await acquireRunLock(
      request({
        runClass: 'heavy',
        pid: 60,
        waitSeconds: 1,
        monotonic: () => now,
        sleep: async () => {
          now += 1000;
        },
      }),
    );

    expect(heavy.kind).toBe('waited-out');
    expect(waiterUnits()).toEqual([]);
  });
});
