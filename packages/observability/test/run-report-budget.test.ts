import { describe, expect, it } from 'vitest';
import { RUN_REPORT_EVENT_TYPES, buildRunReport, createRunReportFold } from '@momonga/observability/run-report';
import type { RunBudgetReport, RunEvent, RunEventPayload } from '@momonga/protocol';
import { materializeEvents } from '@momonga/testkit';

const asPayload = (value: Record<string, unknown>): RunEventPayload => value as unknown as RunEventPayload;

const START: RunEventPayload[] = [
  { type: 'run.status', from: 'QUEUED', to: 'RUNNING' },
  asPayload({ type: 'run.started', attempt: 1, now: 1, pins: { model: 'fm' } }),
];

const call = (callId: string, name: string): RunEventPayload =>
  asPayload({ type: 'tool.call', callId, providerCallId: callId, name, kind: 'execute', sideEffect: 'exec', title: name, rawInput: { command: 'gh pr merge 7' } });

const journalOf = (payloads: readonly RunEventPayload[]): RunEvent[] => materializeEvents([...START, ...payloads], { runId: 'run-1', sessionId: 'sess-1' });

const seqOf = (events: readonly RunEvent[], type: string, callId?: string): number => {
  const found = events.find((event) => event.type === type && (callId === undefined || ('callId' in event && event.callId === callId)));
  if (found === undefined) throw new Error(`the fixture journal has no ${type}`);
  return found.seq;
};

describe('the run report names what stopped the run and carries the budget it is given', () => {
  it('reports the dimension, cause, spent and limit of the budget.exhausted event', () => {
    const report = buildRunReport(
      journalOf([{ type: 'budget.exhausted', dimension: 'cost', cause: 'cap_too_small', spent: 3_900_000, limit: 4_000_000 }, { type: 'run.status', from: 'RUNNING', to: 'STOPPED', reason: 'budget' }]),
    );

    expect(report.stoppedBy).toEqual({ dimension: 'cost', cause: 'cap_too_small', spent: 3_900_000, limit: 4_000_000 });
    expect(report).toMatchObject({ status: 'STOPPED', stopReason: 'budget' });
  });

  it('has no stoppedBy, budget or delegation section for a run with none of their facts', () => {
    const report = buildRunReport(journalOf([{ type: 'run.status', from: 'RUNNING', to: 'COMPLETED' }]));

    expect('stoppedBy' in report).toBe(false);
    expect('budget' in report).toBe(false);
    expect('delegation' in report).toBe(false);
  });

  it('carries the limits, the spend and the reservations it is finished with, unchanged', () => {
    const budget: RunBudgetReport = {
      limits: { maxSteps: 50, maxTotalTokens: 1_000_000, maxCostNano: 4_000_000, deadlineAt: 99 },
      spent: { steps: 3, totalTokens: 1200, costNano: 3_900_000, unpricedCalls: 0 },
      reserved: { tokens: 0, costNano: 0 },
    };
    const fold = createRunReportFold();

    expect(fold.finish({ runId: 'run-1', firstCreatedAt: 1, lastCreatedAt: 2, budget }).budget).toEqual(budget);
  });

  it('asks the reader for the budget and hold events', () => {
    expect(RUN_REPORT_EVENT_TYPES).toEqual(expect.arrayContaining(['budget.exhausted', 'tool.held', 'tool.held.resolved', 'run.quiescent']));
  });
});

describe('the run report lists the calls a mandate run held and denied', () => {
  const held = (callId: string): RunEventPayload => ({ type: 'tool.held', callId, approvalId: `ap-${callId}`, reason: 'merging needs a person', footprint: { reads: [], writes: [] } });

  it('lists a held call with its tool and reason, open until it is resolved, then with its outcome and the status of the late result', () => {
    const open = journalOf([call('m1', 'PullRequestMerge'), held('m1'), { type: 'run.quiescent', held: [{ callId: 'm1', approvalId: 'ap-m1', tool: 'PullRequestMerge', reason: 'merging needs a person', sinceSeq: 4 }] }]);
    const resolved = journalOf([
      call('m1', 'PullRequestMerge'),
      held('m1'),
      call('m2', 'Bash'),
      held('m2'),
      { type: 'tool.held.resolved', callId: 'm1', approvalId: 'ap-m1', outcome: 'executed', status: 'completed', output: 'merged' },
      { type: 'tool.held.resolved', callId: 'm2', approvalId: 'ap-m2', outcome: 'withdrawn', status: 'failed', output: 'withdrawn' },
    ]);

    expect(buildRunReport(open).delegation).toEqual({
      held: [{ callId: 'm1', tool: 'PullRequestMerge', reason: 'merging needs a person', heldSeq: seqOf(open, 'tool.held') }],
      denied: [],
      quiescent: true,
    });
    expect(buildRunReport(resolved).delegation).toEqual({
      held: [
        { callId: 'm1', tool: 'PullRequestMerge', reason: 'merging needs a person', heldSeq: seqOf(resolved, 'tool.held', 'm1'), outcome: 'executed', status: 'completed', resolvedSeq: seqOf(resolved, 'tool.held.resolved', 'm1') },
        { callId: 'm2', tool: 'Bash', reason: 'merging needs a person', heldSeq: seqOf(resolved, 'tool.held', 'm2'), outcome: 'withdrawn', status: 'failed', resolvedSeq: seqOf(resolved, 'tool.held.resolved', 'm2') },
      ],
      denied: [],
      quiescent: false,
    });
  });

  it('lists a call denied as outside the mandate and one blocked by a held call, and no denial of another source', () => {
    const denied = (callId: string, source: string): RunEventPayload => asPayload({ type: 'tool.completed', callId, status: 'failed', output: 'denied', denial: { source, reason: `${source} said no` } });
    const report = buildRunReport(journalOf([call('d1', 'Bash'), denied('d1', 'mandate'), call('d2', 'Edit'), denied('d2', 'held'), call('d3', 'Bash'), denied('d3', 'rule')]));

    expect(report.delegation).toEqual({
      held: [],
      denied: [
        { callId: 'd1', tool: 'Bash', source: 'mandate', reason: 'mandate said no' },
        { callId: 'd2', tool: 'Edit', source: 'held', reason: 'held said no' },
      ],
      quiescent: false,
    });
    expect(report.residualRisk).toContainEqual({ code: 'permission_denials', count: 3 });
  });

  it('refuses a resolution of a call that was never held', () => {
    expect(() => buildRunReport(journalOf([call('m1', 'Bash'), { type: 'tool.held.resolved', callId: 'm1', approvalId: 'ap', outcome: 'rejected', status: 'failed', output: '' }]))).toThrow(/was not held/);
  });
});
