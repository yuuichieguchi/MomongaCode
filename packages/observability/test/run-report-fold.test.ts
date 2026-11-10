import { describe, expect, it } from 'vitest';
import { RUN_REPORT_EVENT_TYPES, buildRunReport, createRunReportFold } from '@momonga/observability/run-report';
import type { RunEvent, RunEventPayload } from '@momonga/protocol';
import { materializeEvents } from '@momonga/testkit';

const asPayload = (value: Record<string, unknown>): RunEventPayload => value as unknown as RunEventPayload;

const journal = (): RunEvent[] =>
  materializeEvents(
    [
      { type: 'user.message', text: 'fix the bug' },
      { type: 'run.status', from: 'QUEUED', to: 'RUNNING' },
      asPayload({ type: 'run.started', attempt: 1, now: 1, pins: { model: 'fm', mandate: { completion: { conditions: [{ id: 'c-test', command: 'npm test', when: 'always', source: 'request' }], requirements: ['reads well'] } } } }),
      asPayload({ type: 'model.requested', step: 1, attempt: 1, digest: 'd1', body: { input: ['x'.repeat(5000)] } }),
      asPayload({ type: 'tool.call', callId: 'w1', providerCallId: 'w1', name: 'Write', kind: 'edit', sideEffect: 'write', title: 'Write', rawInput: { file_path: '/w/a.txt' } }),
      asPayload({ type: 'tool.started', callId: 'w1', idemKey: 'k-w1', basis: 'rule' }),
      asPayload({ type: 'tool.completed', callId: 'w1', status: 'completed', output: 'ok', files: [{ path: '/w/a.txt', sha256: 'a'.repeat(64), access: 'write' }] }),
      asPayload({ type: 'tool.call', callId: 'b1', providerCallId: 'b1', name: 'Bash', kind: 'execute', sideEffect: 'exec', title: 'npm test', rawInput: { command: 'npm test' } }),
      asPayload({ type: 'tool.started', callId: 'b1', idemKey: 'k-b1', basis: 'rule' }),
      asPayload({ type: 'tool.completed', callId: 'b1', status: 'completed', output: '', exitCode: 0 }),
      asPayload({ type: 'verification.started', round: 1, conditionId: 'c-test', mutationSeq: 10, attempt: 1 }),
      asPayload({ type: 'verification.completed', round: 1, conditionId: 'c-test', outcome: 'passed', exitCode: 0, durationMs: 7, output: '', mutationSeq: 10 }),
      asPayload({ type: 'run.status', from: 'RUNNING', to: 'COMPLETED' }),
      asPayload({ type: 'notice', level: 'info', message: 'after the end' }),
    ],
    { runId: 'run-1', sessionId: 'sess-1' },
  );

const spanOf = (events: readonly RunEvent[]): { runId: string; firstCreatedAt: number; lastCreatedAt: number } => {
  const first = events[0];
  const last = events[events.length - 1];
  if (first === undefined || last === undefined) throw new Error('the fixture journal is empty');
  return { runId: first.runId, firstCreatedAt: first.createdAt, lastCreatedAt: last.createdAt };
};

describe('the run report as a fold that a reader feeds one event at a time', () => {
  it('gives the report of buildRunReport from only the events of RUN_REPORT_EVENT_TYPES and the span of the run', () => {
    const events = journal();
    const fold = createRunReportFold();
    for (const event of events) if ((RUN_REPORT_EVENT_TYPES as readonly string[]).includes(event.type)) fold.add(event);

    expect(fold.finish(spanOf(events))).toEqual(buildRunReport(events));
  });

  it('reads no request body and no model text: neither type is among the types it asks for', () => {
    expect(RUN_REPORT_EVENT_TYPES).not.toContain('model.requested');
    expect(RUN_REPORT_EVENT_TYPES).not.toContain('model.responded');
    expect(RUN_REPORT_EVENT_TYPES).not.toContain('user.message');
  });

  it('measures the duration from the first to the last event of the run, also when neither is an event it folds', () => {
    const events = journal();
    const fold = createRunReportFold();

    expect(fold.finish({ runId: 'run-1', firstCreatedAt: 100, lastCreatedAt: 350 }).durationMs).toBe(250);
    expect(buildRunReport(events).durationMs).toBe((events.at(-1)?.createdAt ?? 0) - (events[0]?.createdAt ?? 0));
  });
});
