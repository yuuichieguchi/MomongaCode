import { describe, expect, it } from 'vitest';
import * as foundation from '@momonga/foundation';
import { MARKER_REAP_GRACE_WINDOWS, gatewayAbortCloseMs, gatewayMaxCloseMs } from '@momonga/foundation';

const exported = foundation as Record<string, unknown>;

const exportOf = <T>(name: string): T => {
  const value = exported[name];
  if (value === undefined) throw new Error(`@momonga/foundation does not export ${name}`);
  return value as T;
};

const SAMPLED_GRACES_MS = [0, 1, 567, 3_000, 60_000] as const;

describe('the managed-server stop names and the revision-6 formula (design-managed-servers section 17, item 16)', () => {
  it('names the terminate waits MANAGED_SERVER_TERMINATE_GRACE_WAITS, two windows', () => {
    expect(exportOf<number>('MANAGED_SERVER_TERMINATE_GRACE_WAITS')).toBe(2);
  });

  it('computes managedServerStopBoundMs as (terminate waits + reap windows) x grace', () => {
    const bound = exportOf<(graceMs: number) => number>('managedServerStopBoundMs');
    for (const grace of SAMPLED_GRACES_MS) expect(bound(grace)).toBe((2 + MARKER_REAP_GRACE_WINDOWS) * grace);
  });

  it('builds the gateway close and abort bounds from managedServerStopBoundMs', () => {
    const bound = exportOf<(graceMs: number) => number>('managedServerStopBoundMs');
    for (const grace of SAMPLED_GRACES_MS) {
      const values = { closeGraceMs: 10_000, managedServerStopGraceMs: grace };
      expect(gatewayMaxCloseMs(values)).toBe(10_000 + bound(grace));
      expect(gatewayAbortCloseMs(values)).toBe(bound(grace));
    }
  });

  it('exports no fm-named stop identifier', () => {
    expect(Object.keys(exported).filter((name) => /^fm|^FM_/.test(name))).toEqual([]);
  });
});
