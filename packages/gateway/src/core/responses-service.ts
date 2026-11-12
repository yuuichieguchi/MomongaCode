import { canonicalJson, sha256Hex } from '@momonga/foundation';
import type { StreamEvent } from '@momonga/protocol';
import { parseDeadlineHeader } from './deadline.ts';
import { armDeadline } from './deadline.ts';
import { gatewayClosedError, invalidRequest, runCancelledError } from './errors.ts';
import { createIdempotencyRegistry, parseIdempotencyKey } from './idempotency.ts';
import { normalizeInput } from './input.ts';
import { executeResponse } from './respond.ts';
import type { ResponseJob } from './respond.ts';
import { NEVER_EVICTED, startBufferedRun, startDirectRun } from './run.ts';
import type { WorkRegistry } from './run.ts';
import type { RunSubscription } from './run.ts';
import type { SharedRun } from './run.ts';
import { pinnedServices } from './services.ts';
import type { GatewayServices, Services } from './services.ts';
import type { RequestValidator } from './validation.ts';

export type SubmitHeaders = {
  idempotencyKey: string | undefined;
  deadlineMs: string | undefined;
  traceparent: string | undefined;
  tracestate: string | undefined;
  role: string;
};

export type Submission = {
  stream: boolean;
  events: RunSubscription;
};

export type ResponsesService = {
  submit(rawBody: unknown, headers: SubmitHeaders, signal: AbortSignal): Promise<Submission>;
  cancel(idempotencyKey: string | undefined): boolean;
  abortUnkeyed(reason: unknown): void;
  abortAll(reason: unknown): void;
  activeCount(): number;
};

const withoutStreamFlag = (rawBody: unknown): unknown => {
  if (typeof rawBody !== 'object' || rawBody === null || Array.isArray(rawBody)) return rawBody;
  const { stream: _stream, ...rest } = rawBody as Record<string, unknown>;
  return rest;
};

const parseStep = (value: string | undefined): number | undefined =>
  value !== undefined && /^\d{1,15}$/.test(value) ? Number(value) : undefined;

const replay = (frames: readonly StreamEvent[]): RunSubscription => {
  let cursor = 0;
  return {
    evicted: NEVER_EVICTED,
    next: async () => {
      const frame = frames[cursor];
      if (frame === undefined) return { done: true, value: undefined };
      cursor += 1;
      return { done: false, value: frame };
    },
  };
};

const subscribeWithOwnDeadline = (
  services: GatewayServices,
  run: SharedRun,
  signal: AbortSignal,
  deadlineAt: number | undefined,
): RunSubscription => {
  if (deadlineAt === undefined) return run.subscribe(signal);
  const expiry = new AbortController();
  const disarm = armDeadline(services, deadlineAt, (reason) => expiry.abort(reason));
  let inner: RunSubscription;
  try {
    inner = run.subscribe(AbortSignal.any([signal, expiry.signal]));
  } catch (error) {
    disarm();
    throw error;
  }
  return {
    evicted: inner.evicted,
    next: async () => {
      try {
        const step = await inner.next();
        if (step.done === true) {
          disarm();
          if (expiry.signal.aborted && !signal.aborted) throw expiry.signal.reason;
        }
        return step;
      } catch (error) {
        disarm();
        throw error;
      }
    },
    return: async () => {
      disarm();
      return inner.return?.() ?? { done: true, value: undefined };
    },
  };
};

export const createResponsesService = (services: GatewayServices, validator: RequestValidator, inFlight: WorkRegistry, admitNewCall: () => void): ResponsesService => {
  const registry = createIdempotencyRegistry(services);
  const active = new Set<SharedRun>();
  const keyedRuns = new Set<SharedRun>();

  const startSubmission = async (
    pinned: Services,
    releaseEpoch: () => void,
    rawBody: unknown,
    body: ReturnType<RequestValidator['parseCreate']>,
    deadlineAt: number | undefined,
    headers: SubmitHeaders,
    signal: AbortSignal,
  ): Promise<Submission> => {
    const stream = body.stream === true;

    const key = parseIdempotencyKey(headers.idempotencyKey);
    const digest = key === undefined ? undefined : sha256Hex(canonicalJson(withoutStreamFlag(rawBody)));
    if (key !== undefined && digest !== undefined) {
      const found = await registry.lookup(key, digest, signal);
      if (found.kind === 'inflight') {
        releaseEpoch();
        return { stream, events: subscribeWithOwnDeadline(services, found.run, signal, deadlineAt) };
      }
      if (found.kind === 'stored') {
        releaseEpoch();
        return { stream, events: replay(found.frames) };
      }
      if (services.closeSignal.aborted) throw gatewayClosedError();
    }
    admitNewCall();

    const parent =
      pinned.telemetry === undefined || headers.traceparent === undefined
        ? undefined
        : pinned.telemetry.propagation.extract({
            traceparent: headers.traceparent,
            ...(headers.tracestate === undefined ? {} : { tracestate: headers.tracestate }),
          });
    const job: ResponseJob = {
      model: pinned.router.resolveRequestModel(body.model, body.momonga?.exact_model === true),
      body,
      unknownFields: validator.unknownCreateFields(rawBody),
      clientInput: normalizeInput(body.input),
      idempotency: key === undefined || digest === undefined ? undefined : { key, digest },
      deadlineAt,
      parent,
      runId: body.metadata?.['run_id'],
      step: parseStep(body.metadata?.['step']),
      role: headers.role,
    };
    const work = inFlight.beginWork();
    const onSettled = (): void => {
      work.end();
      releaseEpoch();
      active.delete(run);
      keyedRuns.delete(run);
      if (key !== undefined) registry.end(key, run);
    };
    const run: SharedRun =
      key === undefined
        ? startDirectRun((control) => executeResponse(pinned, job, control), onSettled, work.subscribers)
        : startBufferedRun(
            (control) => executeResponse(pinned, job, control),
            onSettled,
            {
              maxBufferedBytes: services.config.limits.maxIdempotencyFrameBytes,
              readerStallMs: services.config.limits.readerStallMs,
              detachedMaxMs: services.config.detachedMaxMs,
              onAborted: () => registry.end(key, run),
              onSubscribers: work.subscribers,
              timers: services.timers,
            },
          );
    active.add(run);
    if (key !== undefined) keyedRuns.add(run);
    if (key !== undefined && digest !== undefined) registry.begin(key, digest, run);
    return { stream, events: run.subscribe(signal) };
  };

  return {
    submit: async (rawBody, headers, signal) => {
      if (services.closeSignal.aborted) throw gatewayClosedError();
      const body = validator.parseCreate(rawBody);
      const deadlineAt = parseDeadlineHeader(headers.deadlineMs, services.clock.now());
      const lease = await services.epochs.acquire(signal);
      try {
        return await startSubmission(pinnedServices(services, lease.value), lease.release, rawBody, body, deadlineAt, headers, signal);
      } catch (error) {
        lease.release();
        throw error;
      }
    },
    cancel: (idempotencyKey) => {
      const key = parseIdempotencyKey(idempotencyKey);
      if (key === undefined) throw invalidRequest('invalid_idempotency_key', 'the idempotency-key header is required');
      const run = registry.take(key);
      if (run === undefined) return false;
      run.abort(runCancelledError());
      return true;
    },
    abortUnkeyed: (reason) => {
      for (const run of active) if (!keyedRuns.has(run)) run.abort(reason);
    },
    abortAll: (reason) => {
      for (const run of active) run.abort(reason);
    },
    activeCount: () => active.size,
  };
};
