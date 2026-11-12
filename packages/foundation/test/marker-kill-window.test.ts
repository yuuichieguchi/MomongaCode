import { afterMicrotasks, createTempDir, sleepDrivenTiming } from '@momonga/testkit';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { KILL_CONFIRM_MS, POLL_INTERVAL_MS, markerReapClockBoundMs, reapMarkedProcesses } from '@momonga/foundation';
import type { ProcessInspector, Timing } from '@momonga/foundation';

const RECORDED_GROUP = 525_252;
const OWN_GROUP = 525_251;
const HOLDER = 525_253;
const HOLDER_STARTED_AT = 1_700_000_000n;

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const writeMarker = (): string => {
  const dir = createTempDir();
  dirs.push(dir);
  const marker = path.join(dir, 'marker');
  fs.writeFileSync(marker, `${RECORDED_GROUP}\n`, { mode: 0o600 });
  return marker;
};

const errno = (code: string): NodeJS.ErrnoException => Object.assign(new Error(`kill ${code}`), { code });

const holderIgnoringTerm = (releaseAfterKillMs: number | undefined) => {
  let current = 0;
  let killedAt: number | undefined;
  const released = (): boolean => killedAt !== undefined && releaseAfterKillMs !== undefined && current >= killedAt + releaseAfterKillMs;
  const timing: Timing = sleepDrivenTiming({
    now: () => current,
    sleep: async (ms: number) => {
      current += ms;
      await afterMicrotasks();
    },
  });
  const inspector: ProcessInspector = {
    startTimeOf: async () => (released() ? { kind: 'gone' } : { kind: 'value', value: HOLDER_STARTED_AT }),
    holdersOf: async () => ({ kind: 'value', value: released() ? [] : [HOLDER] }),
    groupsOf: async (pids) => ({ kind: 'value', value: new Map(pids.map((pid) => [pid, pid === process.pid ? OWN_GROUP : RECORDED_GROUP])) }),
    markerState: async () => (released() ? 'free' : 'held'),
  };
  const signals: Array<{ pid: number; signal: NodeJS.Signals | number }> = [];
  const kill = (pid: number, signal: NodeJS.Signals | number): void => {
    if (signal === 0) {
      if (released()) throw errno('ESRCH');
      return;
    }
    signals.push({ pid, signal });
    if (signal === 'SIGKILL') killedAt ??= current;
  };
  return { timing, inspector, kill, signals, now: () => current, killedAt: () => killedAt };
};

const GRACES = [0, 2000, 30_000];

describe('a marker reap confirms its SIGKILL in its own window K = KILL_CONFIRM_MS, counted from the SIGKILL, for every grace (design 2.4, point 1)', () => {
  it.each(GRACES)('grace %i: a holder that lets go 2000 ms after the SIGKILL is confirmed gone and the marker is removed', async (killGraceMs) => {
    const marker = writeMarker();
    const host = holderIgnoringTerm(2000);
    const warnings: string[] = [];
    const result = await reapMarkedProcesses({ marker, killGraceMs, label: 'daemon', onWarning: (warning) => warnings.push(warning), kill: host.kill, timing: host.timing, inspector: host.inspector });
    expect(host.signals).toEqual([
      { pid: -RECORDED_GROUP, signal: 'SIGTERM' },
      { pid: -RECORDED_GROUP, signal: 'SIGKILL' },
    ]);
    expect(warnings).toEqual([]);
    expect(result).toEqual({ removed: true });
    expect(fs.existsSync(marker)).toBe(false);
  });

  it.each(GRACES)('grace %i: a holder that outlives the window is reported once by its marker, the reap returns without failing, and the wait after SIGKILL is K, not the grace', async (killGraceMs) => {
    const marker = writeMarker();
    const host = holderIgnoringTerm(undefined);
    const warnings: string[] = [];
    const result = await reapMarkedProcesses({ marker, killGraceMs, label: 'daemon', onWarning: (warning) => warnings.push(warning), kill: host.kill, timing: host.timing, inspector: host.inspector });
    expect(result).toEqual({ removed: false });
    expect(fs.existsSync(marker)).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(marker);
    const afterKill = host.now() - (host.killedAt() ?? Number.NaN);
    expect(afterKill).toBeGreaterThanOrEqual(KILL_CONFIRM_MS);
    expect(afterKill).toBeLessThanOrEqual(KILL_CONFIRM_MS + POLL_INTERVAL_MS);
    expect(host.now()).toBeLessThanOrEqual(markerReapClockBoundMs(killGraceMs));
  });

  it.each(GRACES)('grace %i: markerReapClockBoundMs is three windows of the grace and one K', (killGraceMs) => {
    expect(markerReapClockBoundMs(killGraceMs)).toBe(3 * (killGraceMs + POLL_INTERVAL_MS) + KILL_CONFIRM_MS);
  });
});
