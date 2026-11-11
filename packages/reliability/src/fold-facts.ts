import { INDICATOR_DEFINITIONS_VERSION, TERMINAL_STATUSES, pinnedCompletionOf, pinnedDelegationOf } from '@momonga/protocol';
import type { RecoveryCause, RecoveryEpisodeView, RecoveryOutcome, RunEvent, RunFactsView } from '@momonga/protocol';
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

const declaredCompletion = (event: Extract<FactsEvent, { type: 'run.started' }>): boolean => (pinnedCompletionOf(event.pins)?.conditions.length ?? 0) > 0;

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
  let declared: boolean | undefined;
  let mandated: boolean | undefined;
  let held = 0;
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
    switch (event.type) {
      case 'run.started': {
        declared ??= declaredCompletion(event);
        mandated ??= pinnedDelegationOf(event.pins) !== undefined;
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
        progress(event);
        break;
      case 'tool.call':
        if (event.sideEffect !== 'read_only') sideEffecting.add(event.callId);
        break;
      case 'tool.started': {
        if (event.basis !== undefined) basis[basisKey(event.basis)] += 1;
        if (sideEffecting.has(event.callId) && startedSinceNotApplied.has(event.callId)) repeatedStarts += 1;
        startedSinceNotApplied.add(event.callId);
        openCalls.add(event.callId);
        break;
      }
      case 'tool.held':
        held += 1;
        break;
      case 'tool.held.resolved':
        if (event.outcome !== 'withdrawn') resolvedByPerson += 1;
        break;
      case 'run.quiescent':
        waited = true;
        break;
      case 'tool.completed':
        if (event.denial?.source === 'mandate') denied += 1;
        settle(event.callId);
        progress(event);
        break;
      case 'tool.reconciled': {
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
      ...(mandated === true ? { delegation: { held, resolvedByPerson, denied, waited } } : {}),
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
      declared: declared ?? false,
      met: info.status === 'COMPLETED',
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
