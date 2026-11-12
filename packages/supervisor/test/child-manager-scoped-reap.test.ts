import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_STOP_VALUES, KILL_CONFIRM_MS, momongaPaths, scopeToGeneration } from '@momonga/foundation';
import type { StopValues } from '@momonga/foundation';
import { afterMicrotasks, prepareGenerationForTest, withTempDir } from '@momonga/testkit';
import { createManagerHarness } from './support/p2-manager-harness.ts';

const VALUES: StopValues = { ...DEFAULT_STOP_VALUES, closeGraceMs: 1200, managedServerStopGraceMs: 300 };
const SECOND_GENERATION = 2;

describe('the reap of a gone gateway takes only the managed servers of its own generation (design-update 18.4 A16)', () => {
  it('reaps run/markers/g2/targets for the gateway of generation 2 and no directory of generation 1', async (context) => {
    const home = withTempDir(context, { asHome: true });
    prepareGenerationForTest(home, 1, '1.2.3');
    prepareGenerationForTest(home, SECOND_GENERATION, '1.2.3');
    const reaped: string[] = [];
    const harness = createManagerHarness(context, {
      role: 'gateway',
      overrides: {
        paths: scopeToGeneration(momongaPaths(home, process.platform, {}), SECOND_GENERATION),
        generation: SECOND_GENERATION,
        markerPorts: {
          reapMarkedProcesses: async () => ({ removed: true }),
          reapMarkerDirectory: async (options) => {
            reaped.push(options.dir);
            return { reaped: 0, kept: 0, unreaped: [] };
          },
        },
      },
    });
    await harness.spawnInitial();
    const child = harness.port.last();

    const stopped = harness.manager.stop('shutdown', 'term', VALUES);
    await afterMicrotasks();
    child.exit(0, null);
    await afterMicrotasks();
    harness.timers.advance(KILL_CONFIRM_MS);
    await stopped;

    expect(reaped).toEqual([path.join(home, '.momonga', 'run', 'markers', 'g2', 'targets')]);
  });
});
