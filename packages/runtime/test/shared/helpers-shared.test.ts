import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { momongaLayout, momongaPaths } from '@momonga/foundation';
import { RUNTIME_DEFAULTS, asError, protectedRootAreasOf, reapTimingOf } from '@momonga/runtime';
import { createFakeClock, createFakeTimers } from '@momonga/testkit';

const START_MS = 1_800_000_000_000;
const tempHomes: string[] = [];

afterEach(() => {
  for (const dir of tempHomes.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const tempHome = (): string => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mh-')));
  tempHomes.push(home);
  return home;
};

describe('shared runtime helpers (system timers; reapTimingOf uses fake timers)', () => {
  it('asError returns an Error unchanged and wraps others with a cause', () => {
    const original = new TypeError('kept');
    expect(asError(original)).toBe(original);

    const fromString = asError('plain text');
    expect(fromString).toBeInstanceOf(Error);
    expect(fromString.message).toBe('plain text');
    expect(fromString.cause).toBe('plain text');

    const value = { code: 7, nested: { deep: { deeper: { deepest: 'hidden' } } } };
    const fromObject = asError(value);
    expect(fromObject).toBeInstanceOf(Error);
    expect(fromObject.message).toBe('{ code: 7, nested: { deep: { deeper: [Object] } } }');
    expect(fromObject.cause).toBe(value);

    const fromUndefined = asError(undefined);
    expect(fromUndefined.message).toBe('undefined');
    expect(fromUndefined.cause).toBeUndefined();
    expect(Object.hasOwn(fromUndefined, 'cause')).toBe(true);
  });

  it('reapTimingOf reads the clock and sleeps through the timers', async () => {
    const clock = createFakeClock(START_MS);
    const timers = createFakeTimers(clock);
    const timing = reapTimingOf(clock, timers);

    expect(timing.now()).toBe(START_MS);
    clock.set(START_MS + 25);
    expect(timing.now()).toBe(START_MS + 25);

    let slept = false;
    const sleeping = timing.sleep(500).then(() => {
      slept = true;
    });
    expect(timers.pending()).toEqual([{ id: 1, delayMs: 500, dueAt: START_MS + 525 }]);
    for (let index = 0; index < 5; index += 1) await Promise.resolve();
    expect(slept).toBe(false);

    timers.advance(499);
    for (let index = 0; index < 5; index += 1) await Promise.resolve();
    expect(slept).toBe(false);

    timers.advance(1);
    await sleeping;
    expect(slept).toBe(true);
    expect(timers.pending()).toEqual([]);
    expect(timing.now()).toBe(START_MS + 525);
  });

  it('protectedRootAreasOf returns home/.momonga, the platform keychains, the executables area and the tmp root', () => {
    const home = tempHome();
    const paths = momongaPaths(home, process.platform, {});
    expect([...protectedRootAreasOf(paths, home)].sort()).toEqual([path.join(home, '.momonga'), momongaLayout(home).keychains, path.join(paths.cacheBase, 'executables'), paths.tmp.root].sort());
  });

  it('RUNTIME_DEFAULTS has the documented values', () => {
    expect(RUNTIME_DEFAULTS).toEqual({
      runTimeoutMs: 21_600_000,
      limits: { maxSteps: 50, maxTotalTokens: 1_000_000, approvalTtlMs: 1_800_000, loopThreshold: 3 },
    });
  });
});
