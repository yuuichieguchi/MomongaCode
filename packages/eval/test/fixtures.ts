import { toPublicRunEvent } from '@momonga/protocol';
import type { PublicRunEvent, RunEventPayload } from '@momonga/protocol';
import { approvalWaitResumeRun, finalAnswerRun, materializeEvents, toolRoundTripRun } from '@momonga/testkit';
import type { GoldenCase } from '@momonga/eval';
import type { Transcript, TranscriptRun } from '@momonga/eval';

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
});

export const toolRoundTripTranscript = (caseId: string, runIndex: number): Transcript => ({
  caseId,
  runIndex,
  run: completedRun(`run-${caseId}-${runIndex}`, 2, 59),
  events: publicEventsOf(toolRoundTripRun.payloads),
});

export const approvalTranscript = (caseId: string, runIndex: number): Transcript => ({
  caseId,
  runIndex,
  run: completedRun(`run-${caseId}-${runIndex}`, 2, 48),
  events: publicEventsOf(approvalWaitResumeRun.payloads),
});

export const goldenCase = (overrides: Partial<GoldenCase> & Pick<GoldenCase, 'id' | 'graders'>): GoldenCase => ({
  input: 'do it',
  permissionMode: 'default',
  onAsk: 'reject_once',
  runs: 1,
  minPassRate: 1,
  ...overrides,
});
