import { describe, expect, it } from 'vitest';
import { aggregate, foldFacts, indicatorsOf } from '@momonga/reliability';
import type { RunFacts } from '@momonga/reliability';
import { T0, eventsOf, runInfo, terminal } from './streams.ts';
import type { Timed } from './streams.ts';

const MANDATE = { scope: { allow: ['Read'], ask: ['GitPush'], deny: [] } };

const mandated: Timed[1] = { type: 'run.started', attempt: 1, now: T0, pins: { model: 'fm', mandate: MANDATE } } as Timed[1];

const held = (callId: string, approvalId: string): Timed[1] => ({ type: 'tool.held', callId, approvalId, reason: 'ask', footprint: { reads: [], writes: [] } }) as Timed[1];

const resolved = (callId: string, approvalId: string): Timed[1] => ({ type: 'tool.held.resolved', callId, approvalId, outcome: 'executed', status: 'completed', output: 'ok' }) as Timed[1];

const fold = (runId: string, timed: readonly Timed[]): RunFacts => foldFacts(eventsOf(runId, timed), runInfo({ runId }));

describe('held calls count distinct calls', () => {
  it('counts a call that is held, approved and held again once', () => {
    const facts = fold('again', [
      [T0, mandated],
      [T0 + 1, held('c1', 'a1')],
      [T0 + 2, held('c1', 'a2')],
      [T0 + 3, resolved('c1', 'a2')],
      [T0 + 9, terminal('COMPLETED')],
    ]);
    expect(facts.delegation?.held).toBe(1);
  });

  it('counts two different held calls as two, and the report line sums the calls of the runs', () => {
    const rows = [
      fold('two', [[T0, mandated], [T0 + 1, held('c1', 'a1')], [T0 + 2, held('c2', 'a2')], [T0 + 9, terminal('COMPLETED')]]),
      fold('again', [[T0, mandated], [T0 + 1, held('c1', 'a1')], [T0 + 2, held('c1', 'a2')], [T0 + 9, terminal('COMPLETED')]]),
    ];
    expect(rows.map((row) => row.delegation?.held)).toEqual([2, 1]);
    expect(indicatorsOf(aggregate(rows, { groupBy: 'model' })).total.delegation.held).toBe(3);
  });
});
