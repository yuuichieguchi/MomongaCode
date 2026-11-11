import { describe, expect, it } from 'vitest';
import type { PermissionMode, RunEventPayload } from '@momonga/protocol';
import { aggregate, buildReliabilityReport, decodeReliabilityReport, encodeReliabilityReport, foldFacts, formatReliabilityReport } from '@momonga/reliability';
import type { RunFacts } from '@momonga/reliability';
import { T0, eventsOf, modelResponded, runInfo, started, terminal, toolCall, toolCompleted } from './streams.ts';
import type { Timed } from './streams.ts';

const startedWith = (callId: string, basis: string): RunEventPayload => ({ type: 'tool.started', callId, idemKey: `idem-${callId}`, basis }) as RunEventPayload;

const asked = (callId: string): RunEventPayload => ({
  type: 'tool.permission.requested',
  approvalId: `a-${callId}`,
  callId,
  options: [
    { optionId: 'yes', name: 'Allow once', kind: 'allow_once' },
    { optionId: 'always', name: 'Allow always', kind: 'allow_always' },
    { optionId: 'no', name: 'Reject once', kind: 'reject_once' },
    { optionId: 'never', name: 'Reject always', kind: 'reject_always' },
  ],
  subjectDigest: 's'.repeat(64),
  reason: 'ask',
  shown: { title: 'approval', input: {} },
});

const answered = (callId: string, optionId: string): RunEventPayload => ({ type: 'tool.permission.resolved', approvalId: `a-${callId}`, optionId });

const denied = (callId: string, source: string): RunEventPayload => ({ type: 'tool.completed', callId, status: 'failed', output: 'denied', denial: { source, reason: 'no' } }) as RunEventPayload;

const mandated: RunEventPayload = { type: 'run.started', attempt: 1, now: T0, pins: { model: 'fm', mandate: { scope: { allow: ['Read'], ask: ['GitPush'], deny: [] } } } } as RunEventPayload;

const held = (callId: string): RunEventPayload => ({ type: 'tool.held', callId, approvalId: `h-${callId}`, reason: 'ask', footprint: { reads: [], writes: [] } }) as RunEventPayload;

const heldResolved = (callId: string): RunEventPayload => ({ type: 'tool.held.resolved', callId, approvalId: `h-${callId}`, outcome: 'executed', status: 'completed', output: 'ok' }) as RunEventPayload;

const fold = (runId: string, mode: PermissionMode, timed: readonly Timed[]): RunFacts => foldFacts(eventsOf(runId, timed), runInfo({ runId, mode }));

const manual = fold('r-manual', 'manual', [
  [T0, started(1)],
  [T0 + 1, toolCall('c1', 'read_only')],
  [T0 + 2, startedWith('c1', 'read_only')],
  [T0 + 3, toolCompleted('c1')],
  [T0 + 4, toolCall('c2', 'write')],
  [T0 + 5, asked('c2')],
  [T0 + 6, answered('c2', 'yes')],
  [T0 + 7, startedWith('c2', 'person')],
  [T0 + 8, toolCompleted('c2')],
  [T0 + 9, toolCall('c3', 'write')],
  [T0 + 10, asked('c3')],
  [T0 + 11, answered('c3', 'never')],
  [T0 + 12, denied('c3', 'rule')],
  [T0 + 13, toolCall('c4', 'write')],
  [T0 + 14, asked('c4')],
  [T0 + 20, terminal('COMPLETED')],
]);

const auto = fold('r-auto', 'auto', [
  [T0, started(1)],
  [T0 + 1, toolCall('c1', 'write')],
  [T0 + 2, startedWith('c1', 'classifier')],
  [T0 + 3, toolCompleted('c1')],
  [T0 + 4, toolCall('c2', 'write')],
  [T0 + 5, startedWith('c2', 'rule')],
  [T0 + 6, toolCompleted('c2')],
  [T0 + 7, toolCall('c3', 'write')],
  [T0 + 8, denied('c3', 'sandbox')],
  [T0 + 20, terminal('COMPLETED')],
]);

const mandate = fold('r-mandate', 'bypassPermissions', [
  [T0, mandated],
  [T0 + 1, toolCall('c1', 'write')],
  [T0 + 10, held('c1')],
  [T0 + 20, modelResponded(1)],
  [T0 + 30, toolCall('c2', 'read_only')],
  [T0 + 31, startedWith('c2', 'mode')],
  [T0 + 32, toolCompleted('c2')],
  [T0 + 510, heldResolved('c1')],
  [T0 + 600, terminal('COMPLETED')],
]);

const report = buildReliabilityReport({ kind: 'real', aggregate: aggregate([manual, auto, mandate], { groupBy: 'model' }) });

describe('the permission decisions and the holds of the reliability report (reliability design 5 item 1, budget design 4.6)', () => {
  it('folds the answer kinds of the asks, the denials by source, the work done while a call was held and the hold latency', () => {
    expect(manual.answers).toEqual({ allowOnce: 1, allowAlways: 0, rejectOnce: 0, rejectAlways: 1 });
    expect(manual.denials).toEqual({ sandbox: 0, rule: 1, mode: 0, setting: 0, hook: 0, mandate: 0, superseded: 0, held: 0 });
    expect(mandate.delegation).toMatchObject({ holdLatencyMs: 500, workDuringHolds: { modelSteps: 1, toolCalls: 1 } });
  });

  it('prints the decisions by basis, the asks, the answer kinds and the denials by source for each mode', () => {
    const text = formatReliabilityReport(report);
    expect(text).toContain('Permission decisions (mode manual): by basis read_only 1, rule 0, mode 0, hook 0, classifier 0, person 1; asks 3; answers allow_once 1, allow_always 0, reject_once 0, reject_always 1, unanswered 1; denials sandbox 0, rule 1, mode 0, setting 0, hook 0, mandate 0, superseded 0, held 0');
    expect(text).toContain('Permission decisions (mode auto): by basis read_only 0, rule 1, mode 0, hook 0, classifier 1, person 0; asks 0; answers allow_once 0, allow_always 0, reject_once 0, reject_always 0, unanswered 0; denials sandbox 1, rule 0, mode 0, setting 0, hook 0, mandate 0, superseded 0, held 0');
    expect(text).toContain('Permission decisions (mode bypassPermissions): by basis read_only 0, rule 0, mode 1, hook 0, classifier 0, person 0; asks 0;');
  });

  it('prints the work done during holds and the hold latency of the mandate runs', () => {
    expect(formatReliabilityReport(report)).toContain('Holds (mandate runs): work done while a call was held 1 model step, 1 tool call; hold latency mean 500 ms over 1 hold resolved by a person');
  });

  it('keeps every new figure through the codec', () => {
    expect(decodeReliabilityReport(encodeReliabilityReport(report))).toEqual(report);
  });
});
