import { createHash } from 'node:crypto';
import type { ApprovalBasis } from './permission-denial.ts';
import type { SideEffect } from './run-types.ts';

export const VERIFICATION_OUTCOMES = ['passed', 'failed', 'timed_out', 'cancelled', 'spawn_error'] as const;

export type VerificationOutcome = (typeof VERIFICATION_OUTCOMES)[number];

export const CONDITION_WHENS = ['always', 'after_mutation'] as const;

export type ConditionWhen = (typeof CONDITION_WHENS)[number];

export const CONDITION_SOURCES = ['request', 'profile', 'settings'] as const;

export type ConditionSource = (typeof CONDITION_SOURCES)[number];

export const CONDITION_STATES = ['passed', 'failed', 'timed_out', 'cancelled', 'spawn_error', 'stale', 'not_run', 'not_needed'] as const;

export type ConditionState = (typeof CONDITION_STATES)[number];

export const NOT_RUN_REASONS = ['max_steps', 'budget', 'max_tokens', 'timeout', 'loop', 'approval_timeout', 'refusal', 'usage_limit', 'cancelled', 'failed', 'not_needed', 'no_mechanical_check', 'unfinished'] as const;

export type NotRunReason = (typeof NOT_RUN_REASONS)[number];

export const RESIDUAL_RISK_CODES = [
  'no_condition_declared_after_mutation',
  'mutation_without_known_paths',
  'unknown_effect_calls',
  'permission_denials',
  'child_runs_not_completed',
  'output_truncated',
  'requirements_unchecked',
] as const;

export type ResidualRiskCode = (typeof RESIDUAL_RISK_CODES)[number];

export const VERIFICATION_FEEDBACK_PREFIX = '[Completion condition feedback]\n';

const CONDITION_ID_LENGTH = 16;

export const conditionIdOf = (command: string): string => createHash('sha256').update(JSON.stringify({ command })).digest('hex').slice(0, CONDITION_ID_LENGTH);

export type ConditionDeclaration = { id?: string; command: string; timeoutMs?: number; when?: ConditionWhen };

export type CompletionDeclaration = { conditions?: ConditionDeclaration[]; requirements?: string[]; inherit?: boolean };

export type Mandate = { completion?: CompletionDeclaration };

export type PinnedCondition = { id: string; command: string; when: ConditionWhen; source: ConditionSource; timeoutMs?: number };

export type PinnedCompletion = { conditions: PinnedCondition[]; requirements: string[] };

export type ConditionResult = { seq: number; outcome: VerificationOutcome; mutationSeq: number };

export type PendingCheck = { round: number; attempt: number };

export type VerificationState = {
  round: number;
  results: Record<string, ConditionResult>;
  pending?: Record<string, PendingCheck>;
  lastFailedRoundMutationSeq?: number;
};

export const initialVerificationState = (): VerificationState => ({ round: 0, results: {} });

export const withVerificationStarted = (state: VerificationState, event: { round: number; conditionId: string; attempt: number }): VerificationState => ({
  ...state,
  round: Math.max(state.round, event.round),
  pending: { ...state.pending, [event.conditionId]: { round: event.round, attempt: event.attempt } },
});

export const withVerificationCompleted = (
  state: VerificationState,
  event: { round: number; conditionId: string; outcome: VerificationOutcome; mutationSeq: number; seq: number },
): VerificationState => {
  const { pending, ...rest } = state;
  const { [event.conditionId]: _settled, ...stillPending } = pending ?? {};
  const next: VerificationState = {
    ...rest,
    round: Math.max(state.round, event.round),
    results: { ...state.results, [event.conditionId]: { seq: event.seq, outcome: event.outcome, mutationSeq: event.mutationSeq } },
    ...(Object.keys(stillPending).length === 0 ? {} : { pending: stillPending }),
  };
  return event.outcome === 'passed' ? next : { ...next, lastFailedRoundMutationSeq: event.mutationSeq };
};

export type MutationFacts = { sideEffect?: SideEffect; basis?: ApprovalBasis; rejected: boolean };

const mayWrite = (call: MutationFacts): boolean => call.sideEffect !== 'read_only' && call.basis !== 'read_only';

export const completionMutates = (call: MutationFacts, event: { denial?: unknown; mutated?: true }): boolean => {
  if (event.denial !== undefined || call.rejected) return false;
  return event.mutated === true || mayWrite(call);
};

export const reconciliationMutates = (call: MutationFacts, outcome: 'already_applied' | 'not_applied' | 'unknown'): boolean =>
  outcome !== 'not_applied' && !call.rejected && mayWrite(call);

export const conditionOwed = (condition: { when: ConditionWhen }, lastMutationSeq: number, result: ConditionResult | undefined): boolean =>
  (condition.when === 'always' || lastMutationSeq > 0) && !(result?.outcome === 'passed' && result.mutationSeq === lastMutationSeq);

export type RunReport = {
  runId: string;
  status: string;
  stopReason?: string;
  durationMs: number;
  declaration: { conditions: PinnedCondition[]; requirements: string[] } | null;
  changes: { files: { path: string; sha256?: string; lastSeq: number }[]; mutatingCalls: number };
  conditions: {
    id: string;
    command: string;
    state: ConditionState;
    rounds: number;
    last?: { seq: number; exitCode?: number; durationMs: number; mutationSeq: number; handle?: string };
  }[];
  notRun: { what: string; reason: NotRunReason }[];
  residualRisk: { code: ResidualRiskCode; count: number }[];
  modelChecks: { command: string; exitCode: number; seq: number }[];
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const isOneOf = <T extends string>(values: readonly T[], value: unknown): value is T => values.some((candidate) => candidate === value);

export const readPinnedCompletion = (value: unknown): PinnedCompletion => {
  const malformed = (): Error => new Error('the completion declaration pinned for this run is malformed');
  if (!isRecord(value) || !Array.isArray(value['conditions']) || !Array.isArray(value['requirements'])) throw malformed();
  const conditions = value['conditions'].map((entry: unknown): PinnedCondition => {
    if (
      !isRecord(entry) ||
      typeof entry['id'] !== 'string' ||
      typeof entry['command'] !== 'string' ||
      !isOneOf(CONDITION_WHENS, entry['when']) ||
      !isOneOf(CONDITION_SOURCES, entry['source']) ||
      (entry['timeoutMs'] !== undefined && typeof entry['timeoutMs'] !== 'number')
    ) {
      throw malformed();
    }
    return {
      id: entry['id'],
      command: entry['command'],
      when: entry['when'],
      source: entry['source'],
      ...(entry['timeoutMs'] === undefined ? {} : { timeoutMs: entry['timeoutMs'] }),
    };
  });
  const requirements = value['requirements'].map((entry: unknown): string => {
    if (typeof entry !== 'string') throw malformed();
    return entry;
  });
  return { conditions, requirements };
};

export const pinnedCompletionOf = (pins: Record<string, unknown> | undefined): PinnedCompletion | undefined => {
  const mandate = pins?.['mandate'];
  if (mandate === undefined) return undefined;
  if (!isRecord(mandate)) throw new Error('the mandate pinned for this run is malformed');
  return mandate['completion'] === undefined ? undefined : readPinnedCompletion(mandate['completion']);
};

export const verificationRequiredOf = (pins: Record<string, unknown> | undefined): boolean => pins?.['verificationRequired'] === true;

export const readMandate = (value: unknown, subject: string): Mandate => {
  const malformed = (): Error => new Error(`the mandate of ${subject} is malformed`);
  if (!isRecord(value) || Object.keys(value).some((key) => key !== 'completion')) throw malformed();
  const completion = value['completion'];
  if (completion === undefined) return {};
  if (!isRecord(completion) || Object.keys(completion).some((key) => key !== 'conditions' && key !== 'requirements' && key !== 'inherit')) throw malformed();
  const { conditions, requirements, inherit } = completion;
  if (inherit !== undefined && typeof inherit !== 'boolean') throw malformed();
  if (requirements !== undefined && !(Array.isArray(requirements) && requirements.every((entry) => typeof entry === 'string' && entry !== ''))) throw malformed();
  const readCondition = (entry: unknown): ConditionDeclaration => {
    if (
      !isRecord(entry) ||
      Object.keys(entry).some((key) => key !== 'id' && key !== 'command' && key !== 'timeoutMs' && key !== 'when') ||
      typeof entry['command'] !== 'string' ||
      entry['command'] === '' ||
      (entry['id'] !== undefined && (typeof entry['id'] !== 'string' || entry['id'] === '')) ||
      (entry['timeoutMs'] !== undefined && !(typeof entry['timeoutMs'] === 'number' && Number.isInteger(entry['timeoutMs']) && entry['timeoutMs'] > 0)) ||
      (entry['when'] !== undefined && !isOneOf(CONDITION_WHENS, entry['when']))
    ) {
      throw malformed();
    }
    return {
      ...(entry['id'] === undefined ? {} : { id: entry['id'] as string }),
      command: entry['command'],
      ...(entry['timeoutMs'] === undefined ? {} : { timeoutMs: entry['timeoutMs'] as number }),
      ...(entry['when'] === undefined ? {} : { when: entry['when'] as ConditionWhen }),
    };
  };
  if (conditions !== undefined && !Array.isArray(conditions)) throw malformed();
  return {
    completion: {
      ...(conditions === undefined ? {} : { conditions: (conditions as unknown[]).map(readCondition) }),
      ...(requirements === undefined ? {} : { requirements: [...(requirements as string[])] }),
      ...(inherit === undefined ? {} : { inherit }),
    },
  };
};
