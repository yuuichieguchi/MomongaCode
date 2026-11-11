import { describe, expect, it } from 'vitest';
import { reconcileProcessGroup } from '@momonga/foundation';
import type { MarkerState, ProcessGroupPort, ProcessInspector, Timing } from '@momonga/foundation';
import { createFakeClock, sleepDrivenTiming } from '@momonga/testkit';

const PGID = 1_999_999_031;
const COULD_NOT_CHECK = (reason: string) =>
  `MomongaCode could not check whether a process started by the interrupted command is still running (${reason}). Nothing was stopped. The effect of the interrupted command is unknown; inspect the current state before retrying it.`;
const REASON: Record<'held' | 'unknown', string> = { held: 'no process could be named', unknown: 'the marker state could not be read' };

const inspectorWith = (state: MarkerState): ProcessInspector =>
  ({
    startTimeOf: async () => ({ kind: 'gone' }),
    holdersOf: async () => ({ kind: 'value', value: [] }),
    groupsOf: async () => ({ kind: 'value', value: new Map() }),
    markerState: async () => state,
  }) as unknown as ProcessInspector;

const goneGroup: ProcessGroupPort = { signal: async () => undefined, alive: async () => false };

const reapTiming = (): Timing => {
  const clock = createFakeClock(0);
  return sleepDrivenTiming({ now: () => clock.now(), sleep: async (ms) => void clock.advance(ms) });
};

const reconcile = (state: MarkerState) =>
  reconcileProcessGroup(
    { pgid: PGID, marker: '/nonexistent-marker' },
    { killGraceMs: 100, timing: reapTiming(), inspector: inspectorWith(state), groupPort: goneGroup, signal: new AbortController().signal },
  );

describe('reconcile says the interrupted command is no longer running only when its marker is free', () => {
  it('says no longer running for a free marker, nobody named and no member of the group that can still run', async () => {
    const result = await reconcile('free');
    expect(result.output.startsWith('The interrupted command is no longer running. ')).toBe(true);
    expect(result.stopped).toBe(false);
  });

  it.each<'held' | 'unknown'>(['held', 'unknown'])('says it could not check, never no longer running, for a %s marker with nobody named and no member that can still run', async (state) => {
    const result = await reconcile(state);
    expect(result.output).toBe(COULD_NOT_CHECK(REASON[state]));
    expect(result.outcome).toBe('unknown');
    expect(result.stopped).toBe(false);
    expect(result.leftAloneGroup).toBeUndefined();
  });
});
