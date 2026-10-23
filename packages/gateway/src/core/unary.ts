import { canonicalJson, sha256Hex, uuidv7 } from '@momonga/foundation';
import type {
  CompactRequest,
  CompactResource,
  CompactionItem,
  CountTokensResult,
  InputItem,
} from '@momonga/protocol';
import { armDeadline, parseDeadlineHeader, withDeadline } from './deadline.ts';
import { errorBoundFor, estimateInputTokens } from './estimate.ts';
import { ClientDisconnectedError, detachedRunExpiredError, gatewayClosedError, invalidRequest, isRunCancelled, runCancelledError } from './errors.ts';
import { parseIdempotencyKey, reusedError } from './idempotency.ts';
import { normalizeInput, resolveInput } from './input.ts';
import { failureFrom, runWithRetry } from './retry.ts';
import type { RetryOutcome } from './retry.ts';
import type { TargetRuntime } from './router.ts';
import type { Services } from './services.ts';
import type { RequestValidator } from './validation.ts';

export type UnaryService = {
  countTokens(rawBody: unknown, signal: AbortSignal, deadlineHeader: string | undefined): Promise<CountTokensResult>;
  compact(
    rawBody: unknown,
    signal: AbortSignal,
    deadlineHeader: string | undefined,
    idempotencyKeyHeader: string | undefined,
  ): Promise<CompactResource>;
  cancel(idempotencyKeyHeader: string | undefined): boolean;
  abortAll(reason: unknown): void;
  settled(): Promise<void>;
  activeCount(): number;
};

type InflightCompaction = {
  digest: string;
  controller: AbortController;
  promise: Promise<CompactResource>;
  subscribers: number;
  detachTimer: unknown;
};

const identifier = (services: Services, prefix: string): string => `${prefix}_${uuidv7(services.clock).replaceAll('-', '')}`;

const callTargets = <T>(
  services: Services,
  candidates: readonly TargetRuntime[],
  signal: AbortSignal,
  deadlineAt: number | undefined,
  call: (target: TargetRuntime, attemptNumber: number, signal: AbortSignal) => Promise<T>,
): Promise<RetryOutcome<T>> =>
  withDeadline(services, deadlineAt, signal, (guarded) =>
    runWithRetry({
      candidates,
      policy: { ...services.config.retry, random: services.random, clock: services.clock, timers: services.timers },
      signal: guarded,
      deadlineAt,
      attempt: async (target, attemptNumber) => {
        const release = await target.gate.acquire(guarded);
        try {
          return await call(target, attemptNumber, guarded);
        } catch (error) {
          throw failureFrom(target.adapter, error, guarded);
        } finally {
          release();
        }
      },
    }),
  );

const countTokens = async (
  services: Services,
  validator: RequestValidator,
  rawBody: unknown,
  signal: AbortSignal,
  deadlineHeader: string | undefined,
): Promise<CountTokensResult> => {
  const request = validator.parseCountTokens(rawBody);
  const deadlineAt = parseDeadlineHeader(deadlineHeader, services.clock.now());
  const target = services.router.targetsOf(request.model)[0];
  if (target === undefined) throw new Error(`model alias "${request.model}" has no targets`);
  const resolved = resolveInput(services.store, services.codec, undefined, normalizeInput(request.input));
  const countable: InputItem[] = resolved.forAdapter.map((item) =>
    item.type === 'compaction_summary'
      ? { type: 'message', role: 'user', content: [{ type: 'input_text', text: item.summary }] }
      : item,
  );
  const adapterCountTokens = target.adapter.countTokens;
  if (adapterCountTokens === undefined) {
    const inputTokens = estimateInputTokens({ input: resolved.forAdapter, instructions: request.instructions, tools: request.tools });
    return { input_tokens: inputTokens, method: 'estimated', error_bound: errorBoundFor(inputTokens) };
  }
  const outcome = await callTargets(services, [target], signal, deadlineAt, (chosen, attemptNumber, guarded) =>
    adapterCountTokens.call(
      chosen.adapter,
      {
        model: chosen.model,
        input: countable,
        ...(request.instructions === undefined ? {} : { instructions: request.instructions }),
        ...(request.tools === undefined ? {} : { tools: request.tools }),
      },
      { signal: guarded, target: { name: chosen.name, model: chosen.model }, attempt: attemptNumber },
    ),
  );
  outcome.target.breaker.onSuccess();
  return outcome.value;
};

const compactOnce = async (
  services: Services,
  request: CompactRequest,
  signal: AbortSignal,
  deadlineAt: number | undefined,
): Promise<CompactResource> => {
  const targets = services.router.targetsOf(request.model);
  const resolved = resolveInput(services.store, services.codec, request.previous_response_id, normalizeInput(request.input));
  const candidates = targets.filter((target) => target.adapter.compact !== undefined);
  if (candidates.length === 0) {
    throw invalidRequest('capability_unsupported', `no target of model alias "${request.model}" supports compaction`, 'model');
  }
  const outcome = await callTargets(services, candidates, signal, deadlineAt, (target, attemptNumber, guarded) => {
    const compact = target.adapter.compact;
    if (compact === undefined) throw new TypeError(`target "${target.name}" lost its compact capability`);
    return compact.call(
      target.adapter,
      {
        model: target.model,
        input: resolved.forAdapter,
        ...(request.instructions === undefined ? {} : { instructions: request.instructions }),
      },
      { signal: guarded, target: { name: target.name, model: target.model }, attempt: attemptNumber },
    );
  });
  outcome.target.breaker.onSuccess();
  const item: CompactionItem = {
    type: 'compaction',
    id: identifier(services, 'cmp'),
    encrypted_content: services.codec.encode(outcome.value.summary),
  };
  return {
    id: identifier(services, 'resp'),
    object: 'response.compaction',
    output: [item],
    created_at: Math.floor(services.clock.now() / 1000),
    usage: outcome.value.usage,
  };
};

export const createUnaryService = (services: Services, validator: RequestValidator): UnaryService => {
  const inflight = new Map<string, InflightCompaction>();
  const active = new Set<InflightCompaction>();

  const clearDetachTimer = (entry: InflightCompaction): void => {
    if (entry.detachTimer === undefined) return;
    services.timers.clearTimeout(entry.detachTimer);
    entry.detachTimer = undefined;
  };

  const attach = (entry: InflightCompaction): void => {
    entry.subscribers += 1;
    clearDetachTimer(entry);
  };

  const detach = (entry: InflightCompaction): void => {
    entry.subscribers -= 1;
    if (entry.subscribers > 0 || entry.controller.signal.aborted || entry.detachTimer !== undefined) return;
    entry.detachTimer = services.timers.setTimeout(() => {
      entry.detachTimer = undefined;
      if (entry.subscribers === 0) entry.controller.abort(detachedRunExpiredError());
    }, services.config.detachedMaxMs);
  };

  const wait = async (entry: InflightCompaction, signal: AbortSignal, deadlineAt: number | undefined): Promise<CompactResource> => {
    const expiry = new AbortController();
    const disarm = armDeadline(services, deadlineAt, (reason) => expiry.abort(reason));
    attach(entry);
    try {
      const leaving = AbortSignal.any([signal, expiry.signal]);
      const reasonToLeave = (): unknown => (signal.aborted ? new ClientDisconnectedError() : expiry.signal.reason);
      return await new Promise<CompactResource>((resolve, reject) => {
        const onLeave = (): void => reject(reasonToLeave());
        entry.promise.then(
          (resource) => {
            leaving.removeEventListener('abort', onLeave);
            resolve(resource);
          },
          (error: unknown) => {
            leaving.removeEventListener('abort', onLeave);
            reject(error);
          },
        );
        if (leaving.aborted) onLeave();
        else leaving.addEventListener('abort', onLeave, { once: true });
      });
    } finally {
      disarm();
      detach(entry);
    }
  };

  const compactKeyed = (
    rawBody: unknown,
    key: string,
    signal: AbortSignal,
    deadlineHeader: string | undefined,
  ): Promise<CompactResource> => {
    if (services.closeSignal.aborted) throw gatewayClosedError();
    const request = validator.parseCompact(rawBody);
    const deadlineAt = parseDeadlineHeader(deadlineHeader, services.clock.now());
    const digest = sha256Hex(canonicalJson(request));
    const running = inflight.get(key);
    if (running !== undefined) {
      if (running.digest !== digest) throw reusedError(key);
      return wait(running, signal, deadlineAt);
    }
    const stored = services.store.getCompaction(key);
    if (stored !== undefined) {
      if (services.clock.now() >= stored.expiresAtMs) services.store.deleteCompaction(key);
      else if (stored.digest !== digest) throw reusedError(key);
      else return Promise.resolve(stored.resource);
    }
    const controller = new AbortController();
    const entry: InflightCompaction = {
      digest,
      controller,
      subscribers: 0,
      detachTimer: undefined,
      promise: Promise.resolve().then(async () => {
        try {
          const resource = await compactOnce(services, request, controller.signal, deadlineAt);
          if (isRunCancelled(controller.signal.reason)) throw controller.signal.reason;
          const now = services.clock.now();
          services.store.commitCompaction({ key, digest, resource, createdAtMs: now, expiresAtMs: now + services.config.idempotency.ttlMs });
          return resource;
        } finally {
          clearDetachTimer(entry);
          active.delete(entry);
          if (inflight.get(key) === entry) inflight.delete(key);
        }
      }),
    };
    inflight.set(key, entry);
    active.add(entry);
    return wait(entry, signal, deadlineAt);
  };

  return {
    countTokens: (rawBody, signal, deadlineHeader) => countTokens(services, validator, rawBody, signal, deadlineHeader),
    compact: async (rawBody, signal, deadlineHeader, idempotencyKeyHeader) => {
      const key = parseIdempotencyKey(idempotencyKeyHeader);
      if (key !== undefined) return compactKeyed(rawBody, key, signal, deadlineHeader);
      const request = validator.parseCompact(rawBody);
      const deadlineAt = parseDeadlineHeader(deadlineHeader, services.clock.now());
      return compactOnce(services, request, AbortSignal.any([signal, services.closeSignal]), deadlineAt);
    },
    cancel: (idempotencyKeyHeader) => {
      const key = parseIdempotencyKey(idempotencyKeyHeader);
      if (key === undefined) throw invalidRequest('invalid_idempotency_key', 'the idempotency-key header is required');
      const entry = inflight.get(key);
      if (entry === undefined) return false;
      inflight.delete(key);
      entry.controller.abort(runCancelledError());
      return true;
    },
    abortAll: (reason) => {
      for (const entry of active) entry.controller.abort(reason);
    },
    settled: async () => {
      await Promise.all([...active].map((entry) => entry.promise.then(() => undefined, () => undefined)));
    },
    activeCount: () => active.size,
  };
};
