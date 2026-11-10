import { computeBackoff } from '@momonga/foundation';
import type { Clock } from '@momonga/foundation';
import type { ClassifiedError, FallbackCause, PlanAccountRef, TargetBilling } from '@momonga/protocol';
import { BILLING_CHANGE_ALLOWED, BILLING_CHANGE_REFUSED, DEFERRED_HEADER } from '@momonga/protocol';
import { CandidateRefused, UnprobedTarget, refusalErrorOf } from './candidate-refusal.ts';
import type { Refusal } from './candidate-refusal.ts';
import { breakerVerdictOf } from './breaker-verdict.ts';
import type { BreakerVerdict } from './breaker-verdict.ts';
import { GatewayError, SKIPPABLE_CODES, deadlineExceededError, gatewayErrorFromBody } from './errors.ts';
import type { GuardedAdapter } from './guarded-adapter.ts';
import type { BreakerOutcome, RequestToken } from './request-breaker.ts';
import type { TargetRuntime } from './router.ts';
import type { BillingWalk } from './billing-walk.ts';
import type { GatewayTimers } from '../types.ts';

export class UpstreamFailure extends Error {
  readonly classified: ClassifiedError;

  constructor(classified: ClassifiedError) {
    super(classified.error.message);
    this.name = 'UpstreamFailure';
    this.classified = classified;
  }
}

export const emptyStreamFailure = (): UpstreamFailure =>
  new UpstreamFailure({
    retryable: true,
    error: { type: 'server_error', code: 'empty_upstream_stream', message: 'the upstream ended its stream before sending any output', param: null },
  });

export const failureFrom = (adapter: GuardedAdapter, error: unknown, signal: AbortSignal): unknown => {
  if (error instanceof GatewayError || error instanceof UpstreamFailure || error instanceof CandidateRefused || error instanceof UnprobedTarget) return error;
  if (signal.aborted) return signal.reason;
  return new UpstreamFailure(adapter.classify(error));
};

export type RetryPolicy = {
  maxAttempts: number;
  totalWaitMs: number;
  baseMs: number;
  maxMs: number;
  random: () => number;
  clock: Clock;
  timers: GatewayTimers;
};

export type RetryOutcome<T> = {
  value: T;
  target: TargetRuntime;
  attempts: number;
  fallbackFrom: string[];
  fallbackCauses: FallbackCause[];
  settle(outcome: BreakerOutcome): void;
};

export type RetryRequest<T> = {
  candidates: readonly TargetRuntime[];
  policy: RetryPolicy;
  signal: AbortSignal;
  deadlineAt: number | undefined;
  attempt: (target: TargetRuntime, attemptNumber: number) => Promise<T>;
  refusals?: readonly Refusal[];
  billing: BillingWalk;
};

export type WaitPolicy = { totalWaitMs: number; baseMs: number; maxMs: number; random: () => number };

export type WaitDecision = { kind: 'wait'; ms: number } | { kind: 'leave' };

export type WaitQuestion = { attempt: number; retryAfterMs?: number; elapsedMs: number; policy: WaitPolicy; lastCandidate?: boolean };

export const nextWait = ({ attempt, retryAfterMs, elapsedMs, policy, lastCandidate = false }: WaitQuestion): WaitDecision => {
  const backoffMs = computeBackoff({ attempt, baseMs: policy.baseMs, maxMs: policy.maxMs, random: policy.random, jitter: 'equal' });
  const ms = Math.max(backoffMs, retryAfterMs ?? 0);
  if ((!lastCandidate && ms > policy.maxMs) || elapsedMs + ms > policy.totalWaitMs) return { kind: 'leave' };
  return { kind: 'wait', ms };
};

const sleep = (timers: GatewayTimers, ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const onAbort = (): void => {
      timers.clearTimeout(handle);
      reject(signal.reason);
    };
    const handle = timers.setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });

const retryAfterSeconds = (retryAfterMs: number): string => String(Math.max(1, Math.ceil(retryAfterMs / 1000)));

const finalError = (classified: ClassifiedError, totalWaitMs: number): GatewayError => {
  const { retryAfterMs } = classified;
  if (retryAfterMs === undefined) return gatewayErrorFromBody(classified.error);
  const deferred = retryAfterMs > totalWaitMs;
  return gatewayErrorFromBody(classified.error, {
    'retry-after': retryAfterSeconds(retryAfterMs),
    ...(deferred ? { [DEFERRED_HEADER]: 'true' } : {}),
  });
};

export const plainError = (classified: ClassifiedError): GatewayError =>
  gatewayErrorFromBody(classified.error, classified.retryAfterMs === undefined ? {} : { 'retry-after': retryAfterSeconds(classified.retryAfterMs) });

const openBreakerCause = (target: TargetRuntime): FallbackCause => ({
  target: target.name,
  code: target.lastFailure?.code ?? null,
  message: target.lastFailure?.message ?? 'its circuit breaker is open',
});

const isSkipCode = (code: string | null): boolean => code !== null && SKIPPABLE_CODES.has(code);

const skipsNow = (classified: ClassifiedError): boolean =>
  classified.fallback === undefined ? isSkipCode(classified.error.code) : classified.fallback === 'next' && !classified.retryable;

const billingRefusalOf = (target: TargetRuntime, from: TargetBilling): FallbackCause => ({
  target: target.name,
  code: BILLING_CHANGE_REFUSED,
  message: `changing from ${from} to ${target.billing} billing is not allowed (models.billingChanges)`,
  fromBilling: from,
  toBilling: target.billing,
  reason: BILLING_CHANGE_REFUSED,
});

const notTriedSentence = (refusal: FallbackCause): string => `Model target "${refusal.target}" was not tried: ${refusal.message}.`;

const withNotTried = (error: GatewayError, refusals: readonly FallbackCause[]): GatewayError => {
  if (refusals.length === 0) return error;
  return new GatewayError({
    status: error.status,
    type: error.body.type,
    code: error.body.code,
    message: [error.body.message, ...refusals.map(notTriedSentence)].join(' '),
    param: error.body.param,
    headers: { ...error.headers },
    ...(error.body.plan === undefined ? {} : { plan: error.body.plan }),
  });
};

const withPlan = (error: GatewayError, plan: PlanAccountRef | undefined): GatewayError => {
  if (plan === undefined) return error;
  return new GatewayError({ status: error.status, type: error.body.type, code: error.body.code, message: error.body.message, param: error.body.param, headers: { ...error.headers }, plan });
};

type LastFailure = { kind: 'upstream'; classified: ClassifiedError; plan: PlanAccountRef | undefined } | { kind: 'skip'; error: GatewayError; plan: PlanAccountRef | undefined };

export const runWithRetry = async <T>(request: RetryRequest<T>): Promise<RetryOutcome<T>> => {
  const { candidates, policy, signal, deadlineAt, billing } = request;
  const holder: RequestToken = Symbol('request');
  const fallbackFrom: string[] = [];
  const fallbackCauses: FallbackCause[] = [];
  let attempts = 0;
  let firstSendAt: number | undefined;
  let lastFailure: LastFailure | undefined;
  const refusals: Refusal[] = [...(request.refusals ?? [])];
  const elapsedMs = (): number => (firstSendAt === undefined ? 0 : policy.clock.now() - firstSendAt);
  let kind = billing.initial;
  let leftCause: number | undefined;
  const billingRefusals: FallbackCause[] = [];
  const sentTo = (target: TargetRuntime): void => {
    if (target.billing === kind) return;
    const left = leftCause === undefined ? undefined : { at: leftCause, cause: fallbackCauses[leftCause] };
    if (left?.cause !== undefined) {
      const { target: leftTarget, code, message } = left.cause;
      fallbackCauses[left.at] = { target: leftTarget, code, message, fromBilling: kind, toBilling: target.billing, reason: BILLING_CHANGE_ALLOWED };
    }
    kind = target.billing;
  };
  const eligible = (target: TargetRuntime): boolean => target.billing === kind || billing.allows(kind, target.billing);
  const exhausted = (from: number): never => {
    const notTried = [...billingRefusals, ...candidates.slice(from).filter((target) => !eligible(target)).map((target) => billingRefusalOf(target, kind))];
    if (lastFailure === undefined && refusals.length > 0) throw withNotTried(refusalErrorOf(refusals), notTried);
    if (lastFailure === undefined) throw new Error('runWithRetry ended without trying any candidate');
    if (lastFailure.kind === 'skip') throw withNotTried(withPlan(lastFailure.error, lastFailure.plan), notTried);
    throw withNotTried(withPlan(finalError(lastFailure.classified, policy.totalWaitMs), lastFailure.plan), notTried);
  };

  for (const [index, target] of candidates.entries()) {
    if (!eligible(target)) {
      const refusal = billingRefusalOf(target, kind);
      fallbackCauses.push(refusal);
      billingRefusals.push(refusal);
      continue;
    }
    const nextEligible = (): TargetRuntime | undefined => candidates.slice(index + 1).find(eligible);
    let sends = 0;
    let verdict: BreakerVerdict = 'neutral';
    let causeHere: FallbackCause | undefined;
    let committed = false;
    let refused = false;
    const lastBefore = lastFailure;
    try {
      for (;;) {
        if (signal.aborted) throw signal.reason;
        const next = nextEligible();
        if (next !== undefined && !target.breaker.canPass(holder) && next.breaker.canPass(holder)) break;
        target.breaker.admit(holder);
        firstSendAt ??= policy.clock.now();
        attempts += 1;
        sends += 1;
        try {
          const value = await request.attempt(target, sends);
          sentTo(target);
          committed = true;
          let settled = false;
          return {
            value,
            target,
            attempts,
            fallbackFrom,
            fallbackCauses,
            settle: (outcome) => {
              if (settled) return;
              settled = true;
              target.breaker.record(holder, outcome);
            },
          };
        } catch (error) {
          if (error instanceof UnprobedTarget) throw error.error;
          if (error instanceof CandidateRefused) {
            refusals.push(error.refusal);
            refused = true;
            attempts -= 1;
            lastFailure = lastBefore;
            break;
          }
          sentTo(target);
          const plan = target.servedAccount();
          if (error instanceof GatewayError && isSkipCode(error.body.code)) {
            verdict = 'neutral';
            target.lastFailure = { code: error.body.code, message: error.message };
            causeHere = { target: target.name, ...target.lastFailure };
            lastFailure = { kind: 'skip', error, plan };
            break;
          }
          if (error instanceof GatewayError) throw withPlan(error, plan);
          if (!(error instanceof UpstreamFailure)) throw error;
          const { classified } = error;
          target.lastFailure = { code: classified.error.code, message: classified.error.message };
          causeHere = { target: target.name, ...target.lastFailure };
          if (skipsNow(classified)) {
            verdict = classified.verdict ?? 'neutral';
            lastFailure = { kind: 'skip', error: plainError(classified), plan };
            break;
          }
          verdict = classified.verdict ?? breakerVerdictOf(classified.error.type, classified.error.code);
          if (!classified.retryable || classified.stalled === true) throw withPlan(plainError(classified), plan);
          lastFailure = { kind: 'upstream', classified, plan };
          const movesOn = nextEligible() !== undefined && classified.fallback !== 'stop';
          const decision = nextWait({
            attempt: sends - 1,
            ...(classified.retryAfterMs === undefined ? {} : { retryAfterMs: classified.retryAfterMs }),
            elapsedMs: elapsedMs(),
            policy,
            lastCandidate: !movesOn,
          });
          if (movesOn && (sends >= policy.maxAttempts || decision.kind === 'leave')) break;
          if (decision.kind === 'leave') exhausted(index + 1);
          const waitMs = decision.kind === 'wait' ? decision.ms : 0;
          if (deadlineAt !== undefined && policy.clock.now() + waitMs > deadlineAt) {
            throw deadlineExceededError(`the next retry of target "${target.name}" would start after the request deadline`);
          }
          await sleep(policy.timers, waitMs, signal);
        }
      }
    } finally {
      if (!committed && (sends > 0 || refused)) target.breaker.record(holder, verdict);
    }
    if (refused) continue;
    fallbackFrom.push(target.name);
    leftCause = fallbackCauses.push(causeHere ?? openBreakerCause(target)) - 1;
  }
  return exhausted(candidates.length);
};
