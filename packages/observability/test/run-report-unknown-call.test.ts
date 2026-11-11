import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { buildRunReport } from '@momonga/observability';
import { RUN_API_SCHEMAS } from '@momonga/protocol';
import type { RunEventPayload } from '@momonga/protocol';
import { materializeEvents } from '@momonga/testkit';
import { renderReport } from '../../cli/src/commands/report.ts';

const asPayload = (value: Record<string, unknown>): RunEventPayload => value as unknown as RunEventPayload;

const journal = (payloads: readonly RunEventPayload[]) => materializeEvents(payloads, { runId: 'run-1', sessionId: 'sess-1' });

const opening: RunEventPayload[] = [
  { type: 'user.message', text: 'write the file' },
  { type: 'run.status', from: 'QUEUED', to: 'RUNNING' },
  { type: 'run.started', attempt: 1, now: 1, pins: { model: 'fm' } },
];

const write = (callId: string, status: 'completed' | 'failed'): RunEventPayload[] => [
  asPayload({ type: 'tool.call', callId, providerCallId: callId, name: 'Write', kind: 'edit', sideEffect: 'write', title: 'Write', rawInput: { file_path: '/w/b.txt' } }),
  asPayload({ type: 'tool.started', callId, idemKey: `k-${callId}`, basis: 'rule' }),
  asPayload({ type: 'tool.completed', callId, status, output: status === 'failed' ? 'permission denied' : 'ok', ...(status === 'completed' ? { files: [{ path: '/w/b.txt', access: 'write' }] } : {}) }),
];

describe('store-protocol-C25: a report describes the journal it is given', () => {
  it('shows a tool event for a call the run never announced as one anomaly and keeps the other lines', () => {
    const events = journal([
      ...opening,
      ...write('c1', 'completed'),
      asPayload({ type: 'tool.completed', callId: 'c-ghost', status: 'completed', output: 'ok' }),
      { type: 'run.status', from: 'RUNNING', to: 'COMPLETED' },
    ]);
    const report = buildRunReport(events);
    expect(report.status).toBe('COMPLETED');
    expect(report.changes.mutatingCalls).toBe(1);
    expect(report.anomalies).toEqual([{ seq: events[6]?.seq, type: 'tool.completed', callId: 'c-ghost', cause: 'unknown_call' }]);
    expect(renderReport(report)).toContain('tool.completed at seq');
  });

  it('shows the end of a hold that was never opened as an anomaly', () => {
    const report = buildRunReport(journal([...opening, ...write('c1', 'completed').slice(0, 2), asPayload({ type: 'tool.completed', callId: 'c1', status: 'completed', output: 'ok', held: { approvalId: 'a1' } })]));
    expect(report.anomalies?.map((anomaly) => anomaly.cause)).toEqual(['not_held']);
  });

  it('is admitted by the run schema with its anomalies and its failed calls', () => {
    const report = buildRunReport(journal([...opening, ...write('c1', 'failed'), asPayload({ type: 'tool.started', callId: 'c-ghost', idemKey: 'k', basis: 'rule' })]));
    expect(report.anomalies).toHaveLength(1);
    const { properties } = RUN_API_SCHEMAS.RunView as unknown as { properties: { report: object } };
    const validate = new Ajv2020.default({ strict: true, allErrors: true }).compile(properties.report);
    expect(validate(report), JSON.stringify(validate.errors)).toBe(true);
  });
});

describe('real-use-27: the report states a failed call', () => {
  it('lists a call that failed with its tool, and the text names it', () => {
    const events = journal([...opening, ...write('c1', 'failed'), { type: 'run.status', from: 'RUNNING', to: 'COMPLETED' }]);
    const report = buildRunReport(events);
    expect(report.failedCalls).toEqual([{ callId: 'c1', tool: 'Write', seq: events[5]?.seq }]);
    expect(renderReport(report)).toContain('failed calls:');
    expect(renderReport(report)).toContain('  Write  c1');
  });
});
