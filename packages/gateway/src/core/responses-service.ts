import { canonicalJson, sha256Hex } from '@momonga/foundation';
import type { StreamEvent } from '@momonga/protocol';
import { parseDeadlineHeader } from './deadline.ts';
import { gatewayClosedError, invalidRequest } from './errors.ts';
import { createIdempotencyRegistry, normalizeIdempotencyKey } from './idempotency.ts';
import { normalizeInput } from './input.ts';
import { executeResponse } from './respond.ts';
import type { ResponseJob } from './respond.ts';
import { NEVER_EVICTED, startBufferedRun, startDirectRun } from './run.ts';
import type { RunSubscription } from './run.ts';
import type { SharedRun } from './run.ts';
import type { Services } from './services.ts';
import type { RequestValidator } from './validation.ts';

export type SubmitHeaders = {
  idempotencyKey: string | undefined;
  deadlineMs: string | undefined;
  traceparent: string | undefined;
  tracestate: string | undefined;
};

export type Submission = {
  stream: boolean;
  events: RunSubscription;
};

export type ResponsesService = {
  submit(rawBody: unknown, headers: SubmitHeaders, signal: AbortSignal): Submission;
  abortAll(reason: unknown): void;
  settled(): Promise<void>;
  activeCount(): number;
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

export const createResponsesService = (services: Services, validator: RequestValidator): ResponsesService => {
  const registry = createIdempotencyRegistry(services);
  const active = new Set<SharedRun>();

  return {
    submit: (rawBody, headers, signal) => {
      if (services.closeSignal.aborted) throw gatewayClosedError();
      const body = validator.parseCreate(rawBody);
      const deadlineAt = parseDeadlineHeader(headers.deadlineMs, services.clock.now());
      services.router.targetsOf(body.model);
      const stream = body.stream === true;

      const key = headers.idempotencyKey === undefined ? undefined : normalizeIdempotencyKey(headers.idempotencyKey);
      if (key !== undefined && key === '') throw invalidRequest('invalid_idempotency_key', 'the idempotency-key header must not be empty');
      const digest = key === undefined ? undefined : sha256Hex(canonicalJson(rawBody));
      if (key !== undefined && digest !== undefined) {
        const found = registry.lookup(key, digest);
        if (found.kind === 'inflight') return { stream, events: found.run.subscribe(signal) };
        if (found.kind === 'stored') return { stream, events: replay(found.frames) };
      }

      const parent =
        services.telemetry === undefined || headers.traceparent === undefined
          ? undefined
          : services.telemetry.propagation.extract({
              traceparent: headers.traceparent,
              ...(headers.tracestate === undefined ? {} : { tracestate: headers.tracestate }),
            });
      const job: ResponseJob = {
        alias: body.model,
        body,
        clientInput: normalizeInput(body.input),
        idempotency: key === undefined || digest === undefined ? undefined : { key, digest },
        deadlineAt,
        parent,
        runId: body.metadata?.['run_id'],
        step: parseStep(body.metadata?.['step']),
      };
      const onSettled = (): void => {
        active.delete(run);
        if (key !== undefined) registry.end(key, run);
      };
      const run: SharedRun =
        key === undefined
          ? startDirectRun((control) => executeResponse(services, job, control), onSettled)
          : startBufferedRun(
              (control) => executeResponse(services, job, control),
              onSettled,
              {
                maxBufferedBytes: services.config.limits.maxIdempotencyFrameBytes,
                readerStallMs: services.config.limits.idempotencyReaderStallMs,
                timers: services.timers,
              },
            );
      active.add(run);
      if (key !== undefined && digest !== undefined) registry.begin(key, digest, run);
      return { stream, events: run.subscribe(signal) };
    },
    abortAll: (reason) => {
      for (const run of active) run.abort(reason);
    },
    settled: async () => {
      await Promise.all([...active].map((run) => run.settled));
    },
    activeCount: () => active.size,
  };
};
