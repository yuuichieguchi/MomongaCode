import { computeBackoff } from '@momonga/foundation';
import type { Clock } from '@momonga/foundation';
import type { ClassifiedError, ProviderAdapter } from '@momonga/protocol';
import { applyBreakerVerdict, breakerVerdictOf } from './breaker-verdict.ts';
import { GatewayError, deadlineExceededError, gatewayErrorFromBody, serverError } from './errors.ts';
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

export const failureFrom = (adapter: ProviderAdapter, error: unknown, signal: AbortSignal): unknown => {
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

export const runWithRetry = async <T>(request: RetryRequest<T>): Promise<RetryOutcome<T>> => {
  const { candidates, policy, signal, deadlineAt } = request;
  const fallbackFrom: string[] = [];
  let attempts = 0;
  let lastFailure: UpstreamFailure | undefined;
  for (const target of candidates) {
    for (let attemptNumber = 1; attemptNumber <= policy.maxAttempts; attemptNumber += 1) {
      if (signal.aborted) throw signal.reason;
      if (!target.breaker.canPass()) break;
      attempts += 1;
      try {
        const value = await request.attempt(target, attemptNumber);
        return { value, target, attempts, fallbackFrom };
      } catch (error) {
        if (!(error instanceof UpstreamFailure)) throw error;
        const { classified } = error;
        applyBreakerVerdict(target.breaker, breakerVerdictOf(classified.error.type, classified.error.code));
        if (!classified.retryable) throw gatewayErrorFromBody(classified.error, retryAfterHeader(classified));
        lastFailure = error;
        if (attemptNumber === policy.maxAttempts) break;
        const backoffMs = computeBackoff({
          attempt: attemptNumber - 1,
          baseMs: policy.baseMs,
          maxMs: policy.maxMs,
          random: policy.random,
        });
        const waitMs = Math.max(backoffMs, error.classified.retryAfterMs ?? 0);
        if (deadlineAt !== undefined && policy.clock.now() + waitMs > deadlineAt) {
          throw deadlineExceededError(`the next retry of target "${target.name}" would start after the request deadline`);
        }
        await sleep(policy.timers, waitMs, signal);
      }
    }
    fallbackFrom.push(target.name);
  }
  if (lastFailure !== undefined) throw gatewayErrorFromBody(lastFailure.classified.error, retryAfterHeader(lastFailure.classified));
  throw serverError(503, 'all_targets_unavailable', 'every candidate target is unavailable because its circuit breaker is open');
};
