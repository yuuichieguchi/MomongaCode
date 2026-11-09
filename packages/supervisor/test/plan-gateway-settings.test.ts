import { describe, expect, it } from 'vitest';
import { loadUserSettings } from '@momonga/config';
import { withTempDir } from '@momonga/testkit';
import { digestsOf, planRoles } from '../src/plan.ts';
import { writeSettings } from './support/p2-manager-harness.ts';

const resolvedWith = async (home: string, gateway: Record<string, number>) => {
  writeSettings(home, { gateway });
  return (await loadUserSettings({ home })).settings;
};

describe('a change of the gateway stop settings restarts nothing (decided: read at stop begin)', () => {
  it('leaves every digest the restart plan compares unchanged, so no role is planned for a restart', async (context) => {
    const home = withTempDir(context, { asHome: true });
    const before = digestsOf(await resolvedWith(home, { closeGraceMs: 10_000, managedServerStopGraceMs: 3000 }));
    const after = digestsOf(await resolvedWith(home, { closeGraceMs: 0, managedServerStopGraceMs: 60_000 }));
    expect(after).toEqual(before);
    expect(planRoles(after, { runtime: before, gateway: { models: before.models, telemetry: before.telemetry, network: before.network } })).toEqual([]);
  });
});
