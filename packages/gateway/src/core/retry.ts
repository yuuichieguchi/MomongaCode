import { computeBackoff } from '@momonga/foundation';
import type { Clock, FallbackCause } from '@momonga/foundation';
import type { ClassifiedError } from '@momonga/protocol';
import { DEFERRED_HEADER } from '@momonga/protocol';
import { CandidateRefused, UnprobedTarget, refusalErrorOf } from './candidate-refusal.ts';
import type { Refusal } from './candidate-refusal.ts';
import { breakerVerdictOf } from './breaker-verdict.ts';
import type { BreakerVerdict } from './breaker-verdict.ts';
import { GatewayError, SKIPPABLE_CODES, deadlineExceededError, gatewayErrorFromBody } from './errors.ts';
import type { GuardedAdapter } from './guarded-adapter.ts';
import type { BreakerOutcome, RequestToken } from './request-breaker.ts';
import type { TargetRuntime } from './router.ts';
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

const plainError = (classified: ClassifiedError): GatewayError =>
  gatewayErrorFromBody(classified.error, classified.retryAfterMs === undefined ? {} : { 'retry-after': retryAfterSeconds(classified.retryAfterMs) });

const openBreakerCause = (target: TargetRuntime): FallbackCause => ({
  target: target.name,
  code: target.lastFailure?.code ?? null,
  message: target.lastFailure?.message ?? 'its circuit breaker is open',
});

const isSkipCode = (code: string | null): boolean => code !== null && SKIPPABLE_CODES.has(code);

type LastFailure = { kind: 'upstream'; classified: ClassifiedError } | { kind: 'skip'; error: unknown };

export const runWithRetry = async <T>(request: RetryRequest<T>): Promise<RetryOutcome<T>> => {
  const { candidates, policy, signal, deadlineAt } = request;
  const holder: RequestToken = Symbol('request');
  const fallbackFrom: string[] = [];
  const fallbackCauses: FallbackCause[] = [];
  let attempts = 0;
  let firstSendAt: number | undefined;
  let lastFailure: LastFailure | undefined;
  const refusals: Refusal[] = [...(request.refusals ?? [])];
  const elapsedMs = (): number => (firstSendAt === undefined ? 0 : policy.clock.now() - firstSendAt);
  const exhausted = (): never => {
    if (lastFailure === undefined && refusals.length > 0) throw refusalErrorOf(refusals);
    if (lastFailure === undefined) throw new Error('runWithRetry ended without trying any candidate');
    if (lastFailure.kind === 'skip') throw lastFailure.error;
    throw finalError(lastFailure.classified, policy.totalWaitMs);
  };

  for (const [index, target] of candidates.entries()) {
    const next = candidates[index + 1];
    let sends = 0;
    let verdict: BreakerVerdict = 'neutral';
    let causeHere: FallbackCause | undefined;
    let committed = false;
    let refused = false;
    const lastBefore = lastFailure;
    try {
      for (;;) {
        if (signal.aborted) throw signal.reason;
        if (next !== undefined && !target.breaker.canPass(holder) && next.breaker.canPass(holder)) break;
        target.breaker.admit(holder);
        firstSendAt ??= policy.clock.now();
        attempts += 1;
        sends += 1;
        try {
          const value = await request.attempt(target, sends);
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
          if (error instanceof GatewayError && isSkipCode(error.body.code)) {
            verdict = 'neutral';
            target.lastFailure = { code: error.body.code, message: error.message };
            causeHere = { target: target.name, ...target.lastFailure };
            lastFailure = { kind: 'skip', error };
            break;
          }
          if (!(error instanceof UpstreamFailure)) throw error;
          const { classified } = error;
          target.lastFailure = { code: classified.error.code, message: classified.error.message };
          causeHere = { target: target.name, ...target.lastFailure };
          if (isSkipCode(classified.error.code)) {
            verdict = 'neutral';
            lastFailure = { kind: 'skip', error: plainError(classified) };
            break;
          }
          verdict = breakerVerdictOf(classified.error.type, classified.error.code);
          if (!classified.retryable) throw plainError(classified);
          lastFailure = { kind: 'upstream', classified };
          const backoffMs = computeBackoff({
            attempt: sends - 1,
            baseMs: policy.baseMs,
            maxMs: policy.maxMs,
            random: policy.random,
            jitter: 'equal',
          });
          const waitMs = Math.max(backoffMs, classified.retryAfterMs ?? 0);
          if (next !== undefined && (sends >= policy.maxAttempts || waitMs > policy.maxMs || elapsedMs() + waitMs > policy.totalWaitMs)) break;
          if (elapsedMs() + waitMs > policy.totalWaitMs) exhausted();
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
    fallbackCauses.push(causeHere ?? openBreakerCause(target));
  }
  return exhausted();
};
