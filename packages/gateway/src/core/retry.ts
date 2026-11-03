import { computeBackoff } from '@momonga/foundation';
import type { Clock, FallbackCause } from '@momonga/foundation';
import type { ClassifiedError } from '@momonga/protocol';
import { applyBreakerVerdict, breakerVerdictOf } from './breaker-verdict.ts';
import { GatewayError, SKIPPABLE_CODES, deadlineExceededError, gatewayErrorFromBody, serverError } from './errors.ts';
import type { GuardedAdapter } from './guarded-adapter.ts';
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
    error: { type: 'server_error', code: 'empty_upstream_stream', message: 'the upstream ended its stream before sending any event', param: null },
  });

export const failureFrom = (adapter: GuardedAdapter, error: unknown, signal: AbortSignal): unknown => {
  if (error instanceof GatewayError || error instanceof UpstreamFailure) return error;
  if (signal.aborted) return signal.reason;
  return new UpstreamFailure(adapter.classify(error));
};

export type RetryPolicy = {
  maxAttempts: number;
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
};

export type RetryRequest<T> = {
  candidates: readonly TargetRuntime[];
  policy: RetryPolicy;
  signal: AbortSignal;
  deadlineAt: number | undefined;
  attempt: (target: TargetRuntime, attemptNumber: number) => Promise<T>;
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

const retryAfterHeader = (classified: ClassifiedError): Record<string, string> =>
  classified.retryAfterMs === undefined ? {} : { 'retry-after': String(Math.max(1, Math.ceil(classified.retryAfterMs / 1000))) };

const UNREACHABLE_CODE = 'provider_unavailable';

const openBreakerCause = (target: TargetRuntime): FallbackCause => ({
  target: target.name,
  code: target.lastFailure?.code ?? null,
  message: target.lastFailure?.message ?? 'its circuit breaker is open',
});

const isSkipCode = (code: string | null): boolean => code !== null && SKIPPABLE_CODES.has(code);

type LastFailure = { kind: 'upstream'; failure: UpstreamFailure } | { kind: 'skip'; error: unknown };

export const runWithRetry = async <T>(request: RetryRequest<T>): Promise<RetryOutcome<T>> => {
  const { candidates, policy, signal, deadlineAt } = request;
  const fallbackFrom: string[] = [];
  const fallbackCauses: FallbackCause[] = [];
  let attempts = 0;
  let lastFailure: LastFailure | undefined;
  for (const target of candidates) {
    let causeHere: FallbackCause | undefined;
    for (let attemptNumber = 1; attemptNumber <= policy.maxAttempts; attemptNumber += 1) {
      if (signal.aborted) throw signal.reason;
      if (!target.breaker.canPass()) break;
      attempts += 1;
      try {
        const value = await request.attempt(target, attemptNumber);
        return { value, target, attempts, fallbackFrom, fallbackCauses };
      } catch (error) {
        if (error instanceof GatewayError && isSkipCode(error.body.code)) {
          target.breaker.onNeutral();
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
          target.breaker.onNeutral();
          lastFailure = { kind: 'skip', error: gatewayErrorFromBody(classified.error, retryAfterHeader(classified)) };
          break;
        }
        applyBreakerVerdict(target.breaker, breakerVerdictOf(classified.error.type, classified.error.code));
        if (!classified.retryable) throw gatewayErrorFromBody(classified.error, retryAfterHeader(classified));
        lastFailure = { kind: 'upstream', failure: error };
        if (attemptNumber === policy.maxAttempts) break;
        const backoffMs = computeBackoff({
          attempt: attemptNumber - 1,
          baseMs: policy.baseMs,
          maxMs: policy.maxMs,
          random: policy.random,
        });
        const waitMs = Math.max(backoffMs, error.classified.retryAfterMs ?? 0);
        if (waitMs > policy.maxMs) break;
        if (deadlineAt !== undefined && policy.clock.now() + waitMs > deadlineAt) {
          throw deadlineExceededError(`the next retry of target "${target.name}" would start after the request deadline`);
        }
        await sleep(policy.timers, waitMs, signal);
      }
    }
    fallbackFrom.push(target.name);
    fallbackCauses.push(causeHere ?? openBreakerCause(target));
  }
  if (lastFailure?.kind === 'skip') throw lastFailure.error;
  if (lastFailure?.kind === 'upstream') {
    throw gatewayErrorFromBody(lastFailure.failure.classified.error, retryAfterHeader(lastFailure.failure.classified));
  }
  const causes = fallbackCauses.map((cause) => `${cause.target}: ${cause.message}`).join('; ');
  const unreachable = fallbackCauses.length > 0 && fallbackCauses.every((cause) => cause.code === UNREACHABLE_CODE);
  const trialsFailed = candidates.every((candidate) => candidate.breaker.trialFailed);
  const waitMs = Math.max(...candidates.map((candidate) => candidate.breaker.remainingOpenMs()));
  throw new GatewayError({
    status: 503,
    type: 'server_error',
    code: unreachable && trialsFailed ? 'all_targets_unreachable' : 'all_targets_unavailable',
    message: `every candidate target is unavailable because its circuit breaker is open (${causes})`,
    headers: waitMs > 0 ? { 'retry-after': String(Math.ceil(waitMs / 1000)) } : {},
  });
};
