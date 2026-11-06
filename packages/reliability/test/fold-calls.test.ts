import { describe, expect, it } from 'vitest';
import type { RunEventPayload } from '@momonga/protocol';
import { foldCalls, foldFacts, foldRunRecord } from '@momonga/reliability';
import { T0, eventsOf, permissionRequested, runInfo, started, terminal, toolCall, toolStarted } from './streams.ts';
import type { Timed } from './streams.ts';

const startedWith = (callId: string, basis: string): RunEventPayload => ({ ...toolStarted(callId), basis }) as unknown as RunEventPayload;

const withoutSideEffect = (callId: string): RunEventPayload => {
  const { sideEffect, ...rest } = toolCall(callId, 'write') as RunEventPayload & { sideEffect?: string };
  void sideEffect;
  return rest as RunEventPayload;
};

const TIMED: Timed[] = [
  [T0, started(1)],
  [T0 + 10, toolCall('c1', 'write')],
  [T0 + 20, permissionRequested('c1')],
  [T0 + 30, startedWith('c1', 'person')],
  [T0 + 40, toolCall('c2', 'read_only')],
  [T0 + 50, startedWith('c2', 'read_only')],
  [T0 + 60, toolCall('c3', 'exec')],
  [T0 + 70, withoutSideEffect('c4')],
  [T0 + 80, startedWith('c4', 'rule')],
  [T0 + 90, terminal('COMPLETED')],
];

describe('decision 57: one small row per call, from the same fold', () => {
  it('yields the call id, the decision basis, the side effect and whether the call was asked, in the order the calls appeared', () => {
    expect(foldCalls(eventsOf('r1', TIMED), 'r1')).toEqual([
      { runId: 'r1', callId: 'c1', basis: 'person', sideEffect: 'write', asked: true },
      { runId: 'r1', callId: 'c2', basis: 'read_only', sideEffect: 'read_only', asked: false },
      { runId: 'r1', callId: 'c3', basis: null, sideEffect: 'exec', asked: false },
      { runId: 'r1', callId: 'c4', basis: 'rule', sideEffect: null, asked: false },
    ]);
  });

  it('yields nothing for a journal without calls', () => {
    expect(foldCalls(eventsOf('r1', [[T0, started(1)], [T0 + 1, terminal('COMPLETED')]]), 'r1')).toEqual([]);
  });

  it('foldRunRecord pairs the facts of foldFacts with the call rows over the same events', () => {
    const events = eventsOf('r1', TIMED);
    const info = runInfo({ runId: 'r1' });
    expect(foldRunRecord(events, info)).toEqual({ facts: foldFacts(events, info), calls: foldCalls(events, 'r1') });
  });
});
