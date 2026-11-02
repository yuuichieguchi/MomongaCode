import { toPublicRunEvent } from '@momonga/protocol';
import type { PublicRunEvent, RunEventPayload } from '@momonga/protocol';
import { approvalWaitResumeRun, finalAnswerRun, materializeEvents, toolRoundTripRun } from '@momonga/testkit';
import type { GoldenCase } from '@momonga/eval';
import type { Transcript, TranscriptChild, TranscriptRun } from '@momonga/eval';

export const publicEventsOf = (payloads: readonly RunEventPayload[]): PublicRunEvent[] => materializeEvents(payloads).map(toPublicRunEvent);

const completedRun = (id: string, step: number, totalTokens: number): TranscriptRun => ({
  id,
  status: 'COMPLETED',
  step,
  usage: { inputTokens: totalTokens - 2, outputTokens: 2, totalTokens },
});

export const finalAnswerTranscript = (caseId: string, runIndex: number): Transcript => ({
  caseId,
  runIndex,
  run: completedRun(`run-${caseId}-${runIndex}`, 1, 12),
  events: publicEventsOf(finalAnswerRun.payloads),
  children: [],
});

export const toolRoundTripTranscript = (caseId: string, runIndex: number): Transcript => ({
  caseId,
  runIndex,
  run: completedRun(`run-${caseId}-${runIndex}`, 2, 59),
  events: publicEventsOf(toolRoundTripRun.payloads),
  children: [],
});

export const approvalTranscript = (caseId: string, runIndex: number): Transcript => ({
  caseId,
  runIndex,
  run: completedRun(`run-${caseId}-${runIndex}`, 2, 48),
  events: publicEventsOf(approvalWaitResumeRun.payloads),
  children: [],
});

export type ScriptedCall = {
  callId: string;
  name: string;
  kind: 'read' | 'edit' | 'execute' | 'other';
  rawInput: Record<string, unknown>;
  decision: 'allow' | 'ask' | 'deny';
};

const OPTIONS = [
  { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' as const },
  { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' as const },
];

const payloadsOfCall = (call: ScriptedCall): RunEventPayload[] => [
  { type: 'tool.call', callId: call.callId, providerCallId: call.callId, name: call.name, kind: call.kind, title: call.name, rawInput: call.rawInput },
  ...(call.decision === 'ask'
    ? [{ type: 'tool.permission.requested' as const, approvalId: `a-${call.callId}`, callId: call.callId, options: OPTIONS, subjectDigest: `digest-${call.callId}` }]
    : call.decision === 'allow'
      ? [
          { type: 'tool.started' as const, callId: call.callId, idemKey: `k-${call.callId}` },
          { type: 'tool.completed' as const, callId: call.callId, status: 'completed' as const, output: '' },
        ]
      : [{ type: 'tool.completed' as const, callId: call.callId, status: 'failed' as const, output: 'denied', denial: { source: 'rule' as const, reason: 'denied' } }]),
];

export type ScriptedChild = { runId: string; agent: string; calls: readonly ScriptedCall[] };

export const callsTranscript = (caseId: string, calls: readonly ScriptedCall[], children: readonly ScriptedChild[] = []): Transcript => ({
  caseId,
  runIndex: 0,
  run: completedRun(`run-${caseId}`, 2, 40),
  events: publicEventsOf(calls.flatMap(payloadsOfCall)),
  children: children.map((child): TranscriptChild => ({ runId: child.runId, agent: child.agent, events: publicEventsOf(child.calls.flatMap(payloadsOfCall)) })),
});

export const goldenCase = (overrides: Partial<GoldenCase> & Pick<GoldenCase, 'id' | 'graders'>): GoldenCase => ({
  input: 'do it',
  permissionMode: 'default',
  onAsk: 'reject_once',
  runs: 1,
  minPassRate: 1,
  ...overrides,
});
