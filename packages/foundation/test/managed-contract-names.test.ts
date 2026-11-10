import { describe, expect, it } from 'vitest';
import * as foundation from '@momonga/foundation';
import { DEFAULT_STOP_VALUES, KILL_CONFIRM_MS, markerReapClockBoundMs, gatewayAbortCloseMs, gatewayMaxCloseMs } from '@momonga/foundation';

const exported = foundation as Record<string, unknown>;

const exportOf = <T>(name: string): T => {
  const value = exported[name];
  if (value === undefined) throw new Error(`@momonga/foundation does not export ${name}`);
  return value as T;
};

const SAMPLED_GRACES_MS = [0, 1, 567, 3_000, 60_000] as const;

describe('the managed-server stop names and the revision-8 formula (design-close-grace-settings 2.3)', () => {
  it('computes managedServerStopBoundMs as the TERM wait, the SIGKILL confirmation K and the marker reap clock', () => {
    const bound = exportOf<(graceMs: number) => number>('managedServerStopBoundMs');
    for (const grace of SAMPLED_GRACES_MS) {
      expect(bound(grace)).toBe(grace + KILL_CONFIRM_MS + markerReapClockBoundMs(grace));
      expect(bound(grace)).toBe(4 * grace + 75 + 2 * KILL_CONFIRM_MS);
    }
  });

  it('builds the gateway close and abort bounds from managedServerStopBoundMs', () => {
    const bound = exportOf<(graceMs: number) => number>('managedServerStopBoundMs');
    for (const grace of SAMPLED_GRACES_MS) {
      const values = { ...DEFAULT_STOP_VALUES, closeGraceMs: 10_000, managedServerStopGraceMs: grace };
      expect(gatewayMaxCloseMs(values)).toBe(10_000 + bound(grace));
      expect(gatewayAbortCloseMs(values)).toBe(bound(grace));
    }
  });

  it('exports no fm-named stop identifier', () => {
    expect(Object.keys(exported).filter((name) => /^fm|^FM_/.test(name))).toEqual([]);
  });
});
