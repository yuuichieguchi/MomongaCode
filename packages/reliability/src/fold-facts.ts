import { INDICATOR_DEFINITIONS_VERSION, TERMINAL_STATUSES, completionMutates, delegationOfMandate, heldEndOf, pinnedMandateOf, reconciliationMutates } from '@momonga/protocol';
import type { MutationFacts, PermissionOption, PinnedCompletion, RunFactsAnswers, RunFactsDenials, RecoveryCause, RecoveryEpisodeView, RecoveryOutcome, RunEvent, RunFactsView, RunFactsVerification } from '@momonga/protocol';
import type { RunInfo } from './types.ts';

type Episode = {
  ordinal: number;
  cause: RecoveryCause;
  failedAt: number;
  startedSeq: number;
  awaiting: Set<string>;
  unknownReconciled: boolean;
};

const BASIS_KEYS = { read_only: 'readOnly', rule: 'rule', mode: 'mode', hook: 'hook', classifier: 'classifier', person: 'person' } as const;

const basisKey = (basis: keyof typeof BASIS_KEYS): (typeof BASIS_KEYS)[keyof typeof BASIS_KEYS] => BASIS_KEYS[basis];

const isTerminal = (status: string): boolean => TERMINAL_STATUSES.some((terminal) => terminal === status);

const ANSWER_KEYS = { allow_once: 'allowOnce', allow_always: 'allowAlways', reject_once: 'rejectOnce', reject_always: 'rejectAlways' } as const satisfies Record<PermissionOption['kind'], keyof RunFactsAnswers>;

type Hold = { from: number; to: number };

const conditionsOf = (completion: PinnedCompletion | undefined): PinnedCompletion['conditions'] => completion?.conditions ?? [];

type Rounds = { outcomes: Map<number, boolean>; checkMs: number; firstFailedSeq: number | undefined; fixRoundTokens: number };

const verificationOf = (rounds: Rounds): RunFactsVerification => {
  const ordered = [...rounds.outcomes.entries()].sort(([left], [right]) => left - right);
  return {
    rounds: ordered.length,
    firstRoundPassed: ordered[0]?.[1] ?? null,
    failedRounds: ordered.filter(([, passed]) => !passed).length,
    checkMs: rounds.checkMs,
    fixRoundTokens: rounds.fixRoundTokens,
  };
};

export const FACTS_EVENT_TYPES = [
  'run.started',
  'attempt.failed',
  'attempt.lost',
  'run.status',
  'model.responded',
  'tool.call',
  'tool.started',
  'tool.completed',
  'tool.reconciled',
  'tool.held',
  'tool.held.resolved',
  'run.quiescent',
  'tool.permission.requested',
  'tool.permission.resolved',
  'verification.completed',
  'tool.unknown.requested',
  'tool.elicitation.requested',
  'mcp.authorization.required',
] as const satisfies readonly RunEvent['type'][];

type Unleased<E> = E extends unknown ? Omit<E, 'leaseToken'> : never;

export type FactsEvent = Unleased<RunEvent>;

export type FactsFold = { add(event: FactsEvent): void; finish(info: RunInfo): RunFactsView };

export const createFactsFold = (): FactsFold => {
  const basis = { readOnly: 0, rule: 0, mode: 0, hook: 0, classifier: 0, person: 0 };
  const sideEffecting = new Set<string>();
  const startedSinceNotApplied = new Set<string>();
  const openCalls = new Set<string>();
  const recoveries: RecoveryEpisodeView[] = [];
  let pending: Episode | undefined;
  let ordinal = 0;
  let completion: PinnedCompletion | undefined;
  let started = false;
  const calls = new Map<string, MutationFacts>();
  const approvals = new Map<string, { callId: string; rejecting: Set<string>; kinds: Map<string, PermissionOption['kind']> }>();
  const answers: RunFactsAnswers = { allowOnce: 0, allowAlways: 0, rejectOnce: 0, rejectAlways: 0 };
  const denials: RunFactsDenials = { sandbox: 0, rule: 0, mode: 0, setting: 0, hook: 0, mandate: 0, superseded: 0, held: 0 };
  const heldAt = new Map<string, { seq: number; createdAt: number }>();
  const holds: Hold[] = [];
  const workSeqs: { seq: number; kind: 'model' | 'tool'; callId?: string }[] = [];
  let holdLatencyMs = 0;
  let mutated = false;
  const rounds: Rounds = { outcomes: new Map(), checkMs: 0, firstFailedSeq: undefined, fixRoundTokens: 0 };
  let mandated: boolean | undefined;
  const heldCalls = new Set<string>();
  let resolvedByPerson = 0;
  let denied = 0;
  let waited = false;
  let asked = 0;
  let elicited = 0;
  let authorizationRequired = 0;
  let repeatedStarts = 0;
  let reconciledAlreadyApplied = 0;
  let reconciledNotApplied = 0;
  let reconciledUnknown = 0;
  let humanWaitMs = 0;
  let waitingSince: number | undefined;
  let endedAt: number | undefined;

  const resolve = (episode: Episode, outcome: RecoveryOutcome, progress: { at: number; seq: number } | undefined): void => {
    recoveries.push({
      ordinal: episode.ordinal,
      cause: episode.cause,
      failedAt: episode.failedAt,
      progressAt: progress?.at ?? null,
      outcome,
      startedSeq: episode.startedSeq,
      progressSeq: progress?.seq ?? null,
    });
    pending = undefined;
  };

  const open = (event: FactsEvent, cause: RecoveryCause, failedAt: number): void => {
    if (pending !== undefined) {
      for (const callId of openCalls) pending.awaiting.add(callId);
      return;
    }
    ordinal += 1;
    pending = { ordinal, cause, failedAt, startedSeq: event.seq, awaiting: new Set(openCalls), unknownReconciled: false };
  };

  const closeAt = (event: FactsEvent): void => {
    if (pending === undefined) return;
    const settled = pending.awaiting.size === 0 && !pending.unknownReconciled;
    resolve(pending, settled ? 'recovered' : 'unknown_effect', { at: event.createdAt, seq: event.seq });
  };

  const progress = (event: FactsEvent): void => {
    if (pending === undefined || pending.awaiting.size > 0) return;
    closeAt(event);
  };

  const settle = (callId: string): void => {
    openCalls.delete(callId);
    pending?.awaiting.delete(callId);
  };

  const add = (event: FactsEvent): void => {
    const ended = heldEndOf(event);
    if (ended !== undefined && ended.outcome !== 'withdrawn') resolvedByPerson += 1;
    const heldSince = ended === undefined ? undefined : heldAt.get(ended.callId);
    if (ended !== undefined && heldSince !== undefined) {
      holds.push({ from: heldSince.seq, to: event.seq });
      heldAt.delete(ended.callId);
      if (ended.outcome !== 'withdrawn') holdLatencyMs += event.createdAt - heldSince.createdAt;
    }
    switch (event.type) {
      case 'run.started': {
        if (!started) {
          const mandate = pinnedMandateOf(event.pins);
          completion = mandate?.completion;
          mandated = delegationOfMandate(mandate) !== undefined;
        }
        started = true;
        break;
      }
      case 'attempt.failed':
        open(event, 'worker_failure', event.createdAt);
        break;
      case 'attempt.lost':
        open(event, 'process_lost', event.lastLiveAt);
        break;
      case 'run.status': {
        if (event.from === 'WAITING_HUMAN' && waitingSince !== undefined) {
          humanWaitMs += event.createdAt - waitingSince;
          waitingSince = undefined;
        }
        if (event.to === 'WAITING_HUMAN') waitingSince = event.createdAt;
        if (isTerminal(event.to)) {
          endedAt ??= event.createdAt;
          if (pending !== undefined) {
            if (event.to === 'FAILED') resolve(pending, 'failed', undefined);
            else if (event.to === 'COMPLETED') closeAt(event);
            else resolve(pending, 'stopped', undefined);
          }
        }
        break;
      }
      case 'model.responded':
        if (rounds.firstFailedSeq !== undefined) rounds.fixRoundTokens += event.response.usage.total_tokens;
        workSeqs.push({ seq: event.seq, kind: 'model' });
        progress(event);
        break;
      case 'tool.call':
        if (event.sideEffect !== 'read_only') sideEffecting.add(event.callId);
        calls.set(event.callId, { rejected: false, ...(event.sideEffect === undefined ? {} : { sideEffect: event.sideEffect }) });
        break;
      case 'verification.completed': {
        const passed = event.outcome === 'passed';
        rounds.outcomes.set(event.round, (rounds.outcomes.get(event.round) ?? true) && passed);
        rounds.checkMs += event.durationMs;
        if (!passed) rounds.firstFailedSeq ??= event.seq;
        break;
      }
      case 'tool.started': {
        if (event.basis !== undefined) basis[basisKey(event.basis)] += 1;
        const startedCall = calls.get(event.callId);
        if (startedCall !== undefined && event.basis !== undefined) startedCall.basis = event.basis;
        if (sideEffecting.has(event.callId) && startedSinceNotApplied.has(event.callId)) repeatedStarts += 1;
        startedSinceNotApplied.add(event.callId);
        openCalls.add(event.callId);
        break;
      }
      case 'tool.held':
        heldCalls.add(event.callId);
        heldAt.set(event.callId, { seq: event.seq, createdAt: event.createdAt });
        break;
      case 'run.quiescent':
        waited = true;
        break;
      case 'tool.completed': {
        if (event.denial?.source === 'mandate') denied += 1;
        if (event.denial === undefined) workSeqs.push({ seq: event.seq, kind: 'tool', callId: event.callId });
        else denials[event.denial.source] += 1;
        const completedCall = calls.get(event.callId);
        if (completedCall !== undefined && completionMutates(completedCall, event)) mutated = true;
        settle(event.callId);
        progress(event);
        break;
      }
      case 'tool.reconciled': {
        const reconciledCall = calls.get(event.callId);
        if (reconciledCall !== undefined && reconciliationMutates(reconciledCall, event.outcome)) mutated = true;
        if (event.outcome === 'already_applied') reconciledAlreadyApplied += 1;
        else if (event.outcome === 'not_applied') {
          reconciledNotApplied += 1;
          startedSinceNotApplied.delete(event.callId);
        } else {
          reconciledUnknown += 1;
          if (pending?.awaiting.has(event.callId) === true) pending.unknownReconciled = true;
        }
        settle(event.callId);
        progress(event);
        break;
      }
      case 'tool.permission.requested':
        approvals.set(event.approvalId, {
          callId: event.callId,
          rejecting: new Set(event.options.filter((option) => option.kind.startsWith('reject')).map((option) => option.optionId)),
          kinds: new Map(event.options.map((option) => [option.optionId, option.kind])),
        });
        asked += 1;
        break;
      case 'tool.permission.resolved': {
        const approval = approvals.get(event.approvalId);
        const kind = approval?.kinds.get(event.optionId);
        if (kind !== undefined) answers[ANSWER_KEYS[kind]] += 1;
        const call = approval === undefined ? undefined : calls.get(approval.callId);
        if (approval !== undefined && call !== undefined && approval.rejecting.has(event.optionId)) call.rejected = true;
        break;
      }
      case 'tool.unknown.requested':
        asked += 1;
        break;
      case 'tool.elicitation.requested':
        elicited += 1;
        break;
      case 'mcp.authorization.required':
        authorizationRequired += 1;
        break;
      default:
        break;
    }
  };

  const workDuringHoldsOf = (): { modelSteps: number; toolCalls: number } => {
    const intervals = [...holds, ...[...heldAt.values()].map((held) => ({ from: held.seq, to: Number.POSITIVE_INFINITY }))];
    const during = workSeqs.filter((work) => (work.callId === undefined || !heldCalls.has(work.callId)) && intervals.some((hold) => work.seq > hold.from && work.seq < hold.to));
    return { modelSteps: during.filter((work) => work.kind === 'model').length, toolCalls: during.filter((work) => work.kind === 'tool').length };
  };

  const finish = (info: RunInfo): RunFactsView => {
    if (endedAt === undefined) throw new RangeError(`run ${info.runId}: facts are defined for terminal runs and the journal has no terminal run.status`);
    if (pending !== undefined) throw new RangeError(`run ${info.runId}: the recovery episode opened at seq ${pending.startedSeq} never reached progress or failure`);

    return {
      runId: info.runId,
      rootRunId: info.rootRunId,
      sessionId: info.sessionId,
      definitionsVersion: INDICATOR_DEFINITIONS_VERSION,
      model: info.model,
      mode: info.mode,
      agent: info.agent,
      origin: info.origin,
      status: info.status,
      ...(info.stopReason === undefined ? {} : { stopReason: info.stopReason }),
      createdAt: info.createdAt,
      endedAt,
      elapsedMs: endedAt - info.createdAt,
      humanWaitMs,
      tokensTotal: info.tokensTotal,
      costNano: info.costNano,
      steps: info.step,
      limits: info.limits,
      ...(mandated === true ? { delegation: { held: heldCalls.size, resolvedByPerson, denied, waited, holdLatencyMs, workDuringHolds: workDuringHoldsOf() } } : {}),
      ...(info.deadlineAt === undefined ? {} : { deadlineAt: info.deadlineAt }),
      asked,
      elicited,
      authorizationRequired,
      sideEffectingCalls: sideEffecting.size,
      repeatedStarts,
      reconciledAlreadyApplied,
      reconciledNotApplied,
      reconciledUnknown,
      basis,
      answers,
      denials,
      declared: conditionsOf(completion).length > 0,
      met: info.status === 'COMPLETED',
      mutated,
      owed: conditionsOf(completion).some((condition) => condition.when === 'always' || mutated),
      verification: verificationOf(rounds),
      recoveries,
    };
  };

  return { add, finish };
};

export const foldFacts = (events: readonly FactsEvent[], info: RunInfo): RunFactsView => {
  const fold = createFactsFold();
  for (const event of events) fold.add(event);
  return fold.finish(info);
};
