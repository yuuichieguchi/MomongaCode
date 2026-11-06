import { canonicalJson, sha256Hex, uuidv7 } from '@momonga/foundation';
import { COMPACTION_ROLE, LOWEST_REASONING_EFFORT, MOMONGA_REQUEST_FIELDS, outputTokensFor, summaryInputLimitFor, summaryTokenCapFor } from '@momonga/protocol';
import type {
  AdapterCompactRequest,
  Capabilities,
  AdapterInputItem,
  AdapterRequest,
  CompactRequest,
  CompactResource,
  CompactionItem,
  CountTokensRequest,
  CountTokensResult,
  InputItem,
  LenientItems,
} from '@momonga/protocol';
import { armDeadline, parseDeadlineHeader, withDeadline } from './deadline.ts';
import { estimateInputTokens, estimatedCountOf, imageTokensOfWire, wireTokensOf } from './estimate.ts';
import { ClientDisconnectedError, detachedRunExpiredError, gatewayErrorFromBody, gatewayClosedError, invalidRequest, isRunCancelled, runCancelledError } from './errors.ts';
import { parseIdempotencyKey, reusedError } from './idempotency.ts';
import { inputHasImages, normalizeInput, resolveInput } from './input.ts';
import type { ResolvedInput } from './input.ts';
import { modelCostOf } from './model-cost.ts';
import { startAttemptSpan } from './attempt-span.ts';
import type { AttemptSpan } from './attempt-span.ts';
import { errorTypeOf, messageOf } from './respond.ts';
import { failureFrom, runWithRetry } from './retry.ts';
import type { RetryOutcome } from './retry.ts';
import { adapterContextOf, originOf } from './adapter-context.ts';
import type { Narrowed, TargetRuntime } from './router.ts';
import { CandidateRefused, REFUSAL_STAGES, UnprobedTarget } from './candidate-refusal.ts';
import type { Refusal } from './candidate-refusal.ts';
import type { Services } from './services.ts';
import type { UnknownFields } from './unknown-fields.ts';
import { resolveToolChoice } from './tool-choice.ts';
import { textOfWire } from './wire-text.ts';
import type { RequestValidator } from './validation.ts';

export type UnaryService = {
  countTokens(rawBody: unknown, signal: AbortSignal, deadlineHeader: string | undefined): Promise<CountTokensResult>;
  compact(
    rawBody: unknown,
    signal: AbortSignal,
    deadlineHeader: string | undefined,
    idempotencyKeyHeader: string | undefined,
    trace: CompactTrace,
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
  settled: boolean;
};

const identifier = (services: Services, prefix: string): string => `${prefix}_${uuidv7(services.clock).replaceAll('-', '')}`;

const callTargets = <T>(
  services: Services,
  candidates: readonly TargetRuntime[],
  refusals: readonly Refusal[],
  signal: AbortSignal,
  deadlineAt: number | undefined,
  call: (target: TargetRuntime, attemptNumber: number, signal: AbortSignal) => Promise<T>,
): Promise<RetryOutcome<T>> =>
  withDeadline(services, deadlineAt, signal, (guarded) =>
    runWithRetry({
      candidates,
      refusals,
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

const adapterRequestOf = (model: string, request: CountTokensRequest, input: AdapterInputItem[]): AdapterRequest => ({
  model,
  input,
  ...(request.instructions === undefined ? {} : { instructions: request.instructions }),
  ...(request.tools === undefined || request.tools.length === 0 ? {} : { tools: request.tools }),
  ...(request.tool_choice === undefined ? {} : { tool_choice: request.tool_choice }),
});

const asGatewayError = <T>(target: TargetRuntime, render: () => T): T => {
  try {
    return render();
  } catch (error) {
    throw gatewayErrorFromBody(target.adapter.classify(error).error);
  }
};

type Counted = { result: CountTokensResult; contacted: boolean };

const countWireOnce = async (
  services: Services,
  target: TargetRuntime,
  capabilities: Capabilities,
  wire: Record<string, unknown>,
  signal: AbortSignal,
  attemptNumber: number,
): Promise<Counted> => {
  const context = adapterContextOf(services, target, capabilities, signal, attemptNumber);
  const adapterCountWire = target.adapter.countWire;
  if (adapterCountWire !== undefined) return { result: await adapterCountWire.call(target.adapter, wire, context), contacted: true };
  const adapterCountTokens = target.adapter.countTokens;
  if (adapterCountTokens === undefined) return { result: estimatedCountOf(wireTokensOf(wire, capabilities.imageTokens)), contacted: false };
  const counted = await adapterCountTokens.call(target.adapter, { model: target.model, input: textOfWire(wire) }, context);
  const imageTokens = imageTokensOfWire(wire, capabilities.imageTokens);
  return { result: imageTokens === 0 ? counted : estimatedCountOf(counted.input_tokens + imageTokens), contacted: true };
};

const settleCounted = (outcome: RetryOutcome<Counted>): CountTokensResult => {
  outcome.settle(outcome.value.contacted ? 'success' : 'neutral');
  return outcome.value.result;
};

const countOnTarget = async (
  services: Services,
  target: TargetRuntime,
  narrowed: Narrowed,
  request: CountTokensRequest,
  resolved: ResolvedInput,
  signal: AbortSignal,
  attemptNumber: number,
): Promise<Counted> => {
  const capabilities = await narrowed.capabilitiesOf(target);
  const toolChoiceWire = target.adapter.toolChoiceWire(capabilities, { name: target.name, model: target.model });
  const counted = asGatewayError(target, () =>
    resolveToolChoice(adapterRequestOf(target.model, request, resolved.forAdapter), capabilities.allowedTools, target.name, toolChoiceWire),
  );
  const renderWire = target.adapter.renderWire;
  if (renderWire !== undefined) {
    const lenient = request.momonga?.lenient_items;
    const lenientItems: LenientItems | undefined =
      lenient === undefined ? undefined : { callNames: lenient.call_names, withTools: lenient.with_tools };
    const wire = asGatewayError(target, () =>
      renderWire.call(
        target.adapter,
        counted,
        { name: target.name, model: target.model },
        {
          reasoningOrigin: originOf(services, target),
          capabilities,
          ...(lenientItems === undefined ? {} : { lenientItems }),
        },
      ),
    );
    return countWireOnce(services, target, capabilities, wire, signal, attemptNumber);
  }
  const adapterCountTokens = target.adapter.countTokens;
  if (adapterCountTokens === undefined) {
    const inputTokens = estimateInputTokens(
      { input: resolved.forAdapter, instructions: request.instructions, tools: counted.tools },
      capabilities.imageTokens,
    );
    return { result: estimatedCountOf(inputTokens), contacted: false };
  }
  const countable: InputItem[] = resolved.forAdapter.map((item) =>
    item.type === 'compaction_summary'
      ? { type: 'message', role: 'user', content: [{ type: 'input_text', text: item.summary }] }
      : item,
  );
  const result = await adapterCountTokens.call(
    target.adapter,
    {
      model: target.model,
      input: countable,
      ...(request.instructions === undefined ? {} : { instructions: request.instructions }),
      ...(counted.tools === undefined ? {} : { tools: counted.tools }),
      ...(counted.tool_choice === undefined ? {} : { tool_choice: counted.tool_choice }),
    },
    adapterContextOf(services, target, capabilities, signal, attemptNumber),
  );
  return { result, contacted: true };
};

const countTokens = async (
  services: Services,
  validator: RequestValidator,
  rawBody: unknown,
  signal: AbortSignal,
  deadlineHeader: string | undefined,
): Promise<CountTokensResult> => {
  const request = validator.parseCountTokens(rawBody);
  const unknownFields = validator.unknownCountTokensFields(rawBody);
  const deadlineAt = parseDeadlineHeader(deadlineHeader, services.clock.now());
  const aliasTargets = services.router.targetsOf(request.model);
  const named = request.momonga?.target;
  const found = named === undefined ? undefined : aliasTargets.find((candidate) => candidate.name === named);
  if (named !== undefined && found === undefined) {
    throw invalidRequest('invalid_target', `target "${named}" is not a target of model alias "${request.model}"`, MOMONGA_REQUEST_FIELDS.target);
  }
  const candidates = found === undefined ? aliasTargets : [found];
  if (candidates.length === 0) throw new Error(`model alias "${request.model}" has no targets`);
  const resolved = resolveInput(services.store, services.codec, undefined, normalizeInput(request.input));
  const narrowed = await services.router.narrow(request.model, candidates, {
    images: inputHasImages(resolved.forAdapter),
    toolChoice: { tools: request.tools, tool_choice: request.tool_choice },
    unknownFields: { keys: Object.keys(unknownFields), operation: 'count_tokens' },
  });
  const outcome = await callTargets(services, narrowed.targets, narrowed.refusals, signal, deadlineAt, (chosen, attemptNumber, guarded) =>
    countOnTarget(services, chosen, narrowed, request, resolved, guarded, attemptNumber),
  );
  return settleCounted(outcome);
};

export type CompactTrace = { runId: string | undefined; traceparent: string | undefined; tracestate: string | undefined };

const compactOnce = async (
  services: Services,
  request: CompactRequest,
  unknownFields: UnknownFields,
  signal: AbortSignal,
  deadlineAt: number | undefined,
  trace: CompactTrace,
): Promise<CompactResource> => {
  const targets = services.router.targetsOf(request.model);
  const resolved = resolveInput(services.store, services.codec, request.previous_response_id, normalizeInput(request.input));
  const narrowed = await services.router.narrow(request.model, targets, {
    images: inputHasImages(resolved.forAdapter),
    ...(request.momonga?.max_summary_tokens === undefined ? {} : { summaryCap: request.momonga.max_summary_tokens }),
    unknownFields: { keys: Object.keys(unknownFields), operation: 'compact' },
  });
  const supporting = narrowed.targets.filter((target) => target.adapter.compact !== undefined);
  if (supporting.length === 0) {
    throw invalidRequest('capability_unsupported', `no target of model alias "${request.model}" supports compaction`, 'model');
  }
  const compactRequestFor = (target: TargetRuntime, cap: number): AdapterCompactRequest => ({
    model: target.model,
    input: resolved.forAdapter,
    ...(request.instructions === undefined ? {} : { instructions: request.instructions }),
    momonga: { ...request.momonga, max_summary_tokens: cap },
  });
  const sizeRefusal: Refusal = {
    stage: REFUSAL_STAGES.inputSize,
    error: invalidRequest('compaction_input_too_large', 'the conversation to summarise does not fit the context window of any target', 'input'),
  };
  const capFor = (capabilities: Capabilities): number =>
    request.momonga?.max_summary_tokens ?? Math.min(summaryTokenCapFor(capabilities), capabilities.maxOutputTokens);
  const wireFor = (target: TargetRuntime, capabilities: Capabilities, cap: number): Record<string, unknown> | undefined => {
    const renderCompactWire = target.adapter.renderCompactWire;
    if (renderCompactWire === undefined) return undefined;
    return asGatewayError(target, () =>
      renderCompactWire.call(target.adapter, compactRequestFor(target, cap), { name: target.name, model: target.model }, cap, originOf(services, target), capabilities),
    );
  };
  const fitsWindow = (capabilities: Capabilities, cap: number, counted: CountTokensResult): boolean => {
    const reasoningTokens = outputTokensFor(capabilities, LOWEST_REASONING_EFFORT, cap) - cap;
    return counted.input_tokens + counted.error_bound <= summaryInputLimitFor(capabilities, cap, reasoningTokens);
  };
  const parent =
    services.telemetry === undefined || trace.traceparent === undefined
      ? undefined
      : services.telemetry.propagation.extract({
          traceparent: trace.traceparent,
          ...(trace.tracestate === undefined ? {} : { tracestate: trace.tracestate }),
        });
  const spans = new Map<TargetRuntime, AttemptSpan>();
  const startSpan = (target: TargetRuntime, attemptNumber: number, cap: number | undefined): AttemptSpan =>
    startAttemptSpan({
      telemetry: services.telemetry,
      parent,
      providerName: target.provider,
      billing: target.billing,
      requestModel: target.model,
      maxTokens: cap,
      stream: false,
      runId: trace.runId,
      step: undefined,
      attempt: attemptNumber,
      targetName: target.name,
      role: COMPACTION_ROLE,
      startedAtMs: services.clock.now(),
      request: { input: resolved.forAdapter, instructions: request.instructions, tools: undefined },
    });
  const failSpan = (span: AttemptSpan, failure: unknown): void => span.fail(errorTypeOf(failure), failure, messageOf(failure));
  const outcome = await callTargets(services, supporting, narrowed.refusals, signal, deadlineAt, async (target, attemptNumber, guarded) => {
    const compact = target.adapter.compact;
    if (compact === undefined) throw new TypeError(`target "${target.name}" lost its compact capability`);
    let capabilities: Capabilities;
    let cap: number;
    try {
      capabilities = await narrowed.capabilitiesOf(target);
      cap = capFor(capabilities);
      const wire = wireFor(target, capabilities, cap);
      if (wire !== undefined && !fitsWindow(capabilities, cap, (await countWireOnce(services, target, capabilities, wire, guarded, attemptNumber)).result)) {
        throw new CandidateRefused(sizeRefusal);
      }
    } catch (error) {
      if (error instanceof CandidateRefused || error instanceof UnprobedTarget) throw error;
      const failure = failureFrom(target.adapter, error, guarded);
      failSpan(startSpan(target, attemptNumber, undefined), failure);
      throw failure;
    }
    const span = startSpan(target, attemptNumber, cap);
    try {
      const result = await compact.call(target.adapter, compactRequestFor(target, cap), adapterContextOf(services, target, capabilities, guarded, attemptNumber));
      spans.set(target, span);
      return result;
    } catch (error) {
      const failure = failureFrom(target.adapter, error, guarded);
      failSpan(span, failure);
      throw failure;
    }
  });
  outcome.settle('success');
  const resourceId = identifier(services, 'resp');
  const attempt = spans.get(outcome.target);
  if (attempt === undefined) throw new TypeError(`target "${outcome.target.name}" answered the compaction without an attempt span`);
  attempt.succeed({
    responseModel: outcome.target.model,
    responseId: resourceId,
    finishReason: 'stop',
    usage: outcome.value.usage,
    ...(outcome.value.cacheWriteInputTokens === undefined ? {} : { cacheWriteInputTokens: outcome.value.cacheWriteInputTokens }),
    output: [],
    fallbackCauses: outcome.fallbackCauses,
  });
  const item: CompactionItem = {
    type: 'compaction',
    id: identifier(services, 'cmp'),
    encrypted_content: services.codec.encode(outcome.value.summary),
  };
  const cost =
    services.priceTable === undefined
      ? null
      : modelCostOf({
          provider: outcome.target.provider,
          model: outcome.target.model,
          billing: outcome.target.billing,
          usage: outcome.value.usage,
          cacheWriteInputTokens: outcome.value.cacheWriteInputTokens,
          at: attempt.startedAtMs,
          table: services.priceTable,
        });
  return {
    id: resourceId,
    object: 'response.compaction',
    output: [item],
    created_at: Math.floor(services.clock.now() / 1000),
    usage: outcome.value.usage,
    momonga: {
      target: outcome.target.name,
      ...(outcome.value.cacheWriteInputTokens === undefined ? {} : { cacheWriteInputTokens: outcome.value.cacheWriteInputTokens }),
      ...(cost === null ? {} : { cost }),
    },
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
    if (entry.subscribers > 0 || entry.settled || entry.controller.signal.aborted || entry.detachTimer !== undefined) return;
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
    trace: CompactTrace,
  ): Promise<CompactResource> => {
    if (services.closeSignal.aborted) throw gatewayClosedError();
    const request = validator.parseCompact(rawBody);
    const unknownFields = validator.unknownCompactFields(rawBody);
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
      settled: false,
      promise: Promise.resolve().then(async () => {
        try {
          const resource = await compactOnce(services, request, unknownFields, controller.signal, deadlineAt, trace);
          if (isRunCancelled(controller.signal.reason)) throw controller.signal.reason;
          const now = services.clock.now();
          services.store.commitCompaction({ key, digest, resource, createdAtMs: now, expiresAtMs: now + services.config.idempotency.ttlMs });
          return resource;
        } finally {
          entry.settled = true;
          clearDetachTimer(entry);
          active.delete(entry);
          if (inflight.get(key) === entry) inflight.delete(key);
        }
      }),
    };
    controller.signal.addEventListener(
      'abort',
      () => {
        if (inflight.get(key) === entry) inflight.delete(key);
      },
      { once: true },
    );
    inflight.set(key, entry);
    active.add(entry);
    return wait(entry, signal, deadlineAt);
  };

  return {
    countTokens: (rawBody, signal, deadlineHeader) => countTokens(services, validator, rawBody, signal, deadlineHeader),
    compact: (rawBody, signal, deadlineHeader, idempotencyKeyHeader, trace) => {
      const key = parseIdempotencyKey(idempotencyKeyHeader);
      if (key !== undefined) return compactKeyed(rawBody, key, signal, deadlineHeader, trace);
      const request = validator.parseCompact(rawBody);
      const unknownFields = validator.unknownCompactFields(rawBody);
      const deadlineAt = parseDeadlineHeader(deadlineHeader, services.clock.now());
      return compactOnce(services, request, unknownFields, AbortSignal.any([signal, services.closeSignal]), deadlineAt, trace);
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
