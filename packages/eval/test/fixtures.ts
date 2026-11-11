import { toPublicRunEvent } from '@momonga/protocol';
import type { OutputFormatterName, PublicRunEvent, RunEventPayload } from '@momonga/protocol';
import { approvalWaitResumeRun, finalAnswerRun, materializeEvents, toolRoundTripRun } from '@momonga/testkit';
import type { GoldenCase } from '@momonga/eval';
import type { Transcript, TranscriptChild, TranscriptRun } from '@momonga/eval';

export const RECORDED_CODE_DIGEST = 'c'.repeat(64);

export const RESOLVED_ON_POLICY = {
  context: { adaptiveBudget: true, autoCompact: true, cachePrefix: true, loopGuidance: true, observedCapacity: true, outputFormatters: ['grep', 'identicalOutput', 'json', 'log'] as OutputFormatterName[], unboundedOutputReserve: true },
  tools: { conciseDescriptions: true, deferral: true },
  memory: { reflection: { enabled: true }, repositoryFacts: true },
};

export const RESOLVED_OFF_POLICY = {
  context: { adaptiveBudget: false, autoCompact: false, cachePrefix: false, loopGuidance: false, observedCapacity: false, outputFormatters: [] as OutputFormatterName[], unboundedOutputReserve: false },
  tools: { conciseDescriptions: false, deferral: false },
  memory: { reflection: { enabled: false }, repositoryFacts: false },
};

export const RECORDED_IDENTITY = { policy: RESOLVED_ON_POLICY, codeDigest: RECORDED_CODE_DIGEST } as const;

export const publicEventsOf = (payloads: readonly RunEventPayload[]): PublicRunEvent[] => materializeEvents(payloads).map(toPublicRunEvent);

const completedRun = (id: string, step: number, totalTokens: number): TranscriptRun => ({
  id,
  status: 'COMPLETED',
  step,
  usage: { inputTokens: totalTokens - 2, outputTokens: 2, totalTokens },
});

export const finalAnswerTranscript = (caseId: string, runIndex: number): Transcript => ({
  costs: [],
  caseId,
  runIndex,
  run: completedRun(`run-${caseId}-${runIndex}`, 1, 12),
  events: publicEventsOf(finalAnswerRun.payloads),
  children: [],
  ...RECORDED_IDENTITY,
});

export const toolRoundTripTranscript = (caseId: string, runIndex: number): Transcript => ({
  costs: [],
  caseId,
  runIndex,
  run: completedRun(`run-${caseId}-${runIndex}`, 2, 59),
  events: publicEventsOf(toolRoundTripRun.payloads),
  children: [],
  ...RECORDED_IDENTITY,
});

export const approvalTranscript = (caseId: string, runIndex: number): Transcript => ({
  costs: [],
  caseId,
  runIndex,
  run: completedRun(`run-${caseId}-${runIndex}`, 2, 48),
  events: publicEventsOf(approvalWaitResumeRun.payloads),
  children: [],
  ...RECORDED_IDENTITY,
});

export type ScriptedCall = {
  callId: string;
  name: string;
  kind: 'read' | 'edit' | 'execute' | 'other';
  sideEffect?: 'read_only' | 'write' | 'exec';
  rawInput: Record<string, unknown>;
  decision: 'allow' | 'ask' | 'deny';
};

const sideEffectOf = (call: ScriptedCall): NonNullable<ScriptedCall['sideEffect']> => {
  if (call.sideEffect !== undefined) return call.sideEffect;
  if (call.kind === 'read') return 'read_only';
  return call.kind === 'execute' ? 'exec' : 'write';
};

const OPTIONS = [
  { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' as const },
  { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' as const },
];

const payloadsOfCall = (call: ScriptedCall): RunEventPayload[] => [
  { type: 'tool.call', callId: call.callId, providerCallId: call.callId, name: call.name, kind: call.kind, sideEffect: sideEffectOf(call), title: call.name, rawInput: call.rawInput },
  ...(call.decision === 'ask'
    ? [{ type: 'tool.permission.requested' as const, approvalId: `a-${call.callId}`, callId: call.callId, options: OPTIONS, subjectDigest: `digest-${call.callId}`, reason: 'edits require approval', shown: { title: 'approval', input: {} } }]
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
  costs: [],
  run: completedRun(`run-${caseId}`, 2, 40),
  events: publicEventsOf(calls.flatMap(payloadsOfCall)),
  children: children.map((child): TranscriptChild => ({ runId: child.runId, agent: child.agent, events: publicEventsOf(child.calls.flatMap(payloadsOfCall)) })),
  ...RECORDED_IDENTITY,
});

export const goldenCase = (overrides: Partial<GoldenCase> & Pick<GoldenCase, 'id' | 'graders'>): GoldenCase => ({
  input: 'do it',
  permissionMode: 'manual',
  onAsk: 'reject_once',
  runs: 1,
  minPassRate: 1,
  ...overrides,
});
