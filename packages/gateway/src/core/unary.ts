import { canonicalJson, sha256Hex, uuidv7 } from '@momonga/foundation';
import { COMPACTION_ROLE, LOWEST_REASONING_EFFORT, MIN_SUMMARY_TOKENS, MOMONGA_REQUEST_FIELDS, largestSummaryCapFor, summaryRequestInputLimitFor, wireUsageOf } from '@momonga/protocol';
import { compactionSummaryText } from '@momonga/protocol';
import type {
  AdapterCompactRequest,
  AdapterContext,
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
import { modelCostOf, pricingFieldsOf } from './model-cost.ts';
import { startAttemptSpan } from './attempt-span.ts';
import type { AttemptSpan } from './attempt-span.ts';
import { describeError } from './describe-error.ts';
import { errorTypeOf } from './respond.ts';
import { failureFrom, runWithRetry } from './retry.ts';
import type { RetryOutcome } from './retry.ts';
import { adapterContextOf, originOf } from './adapter-context.ts';
import { outputBoundWithinCostCeiling } from './quote.ts';
import { adapterTargetOf } from './router.ts';
import type { Narrowed, TargetRuntime } from './router.ts';
import { CandidateDropped, CandidateRefused, REFUSAL_STAGES, UnprobedTarget } from './candidate-refusal.ts';
import type { Refusal } from './candidate-refusal.ts';
import type { SharedWorkHold, WorkRegistry } from './run.ts';
import { withPinnedServices } from './services.ts';
import type { GatewayServices, Services } from './services.ts';
import type { UnknownFields } from './unknown-fields.ts';
import { resolveToolChoice } from './tool-choice.ts';
import { textOfWire } from './wire-text.ts';
import type { RequestValidator } from './validation.ts';
import { upstreamCallKey } from './upstream-call-key.ts';
import type { CallIdentity } from './upstream-call-key.ts';

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
  activeCount(): number;
};

type InflightCompaction = {
  digest: string;
  controller: AbortController;
  promise: Promise<CompactResource>;
  subscribers: number;
  detachTimer: unknown;
  settled: boolean;
  work: SharedWorkHold;
};

const SHARED_WORK_HAS_NO_CALLER_DEADLINE = undefined;

const identifier = (services: Services, prefix: string): string => `${prefix}_${uuidv7(services.clock).replaceAll('-', '')}`;

type Sent = { callKey: string; retryOfSeq: number | undefined };

const recordSendOf = async (services: Services, call: CallIdentity, target: TargetRuntime, runId: string | undefined, signal: AbortSignal): Promise<Sent> => {
  const callKey = upstreamCallKey(call, target.name);
  const { retryOfSeq } = await services.store.recordSend({ callKey, target: target.name, runId: runId ?? null, step: null, sentAtMs: services.clock.now() }, signal);
  return { callKey, retryOfSeq };
};

const unkeyedCallOf = (services: Services): CallIdentity => ({ kind: 'unkeyed', nonce: uuidv7(services.clock) });

const callTargets = <T>(
  services: Services,
  candidates: readonly TargetRuntime[],
  narrowed: Pick<Narrowed, 'refusals' | 'billing'>,
  signal: AbortSignal,
  deadlineAt: number | undefined,
  call: (target: TargetRuntime, attemptNumber: number, signal: AbortSignal) => Promise<T>,
): Promise<RetryOutcome<T>> =>
  withDeadline(services, deadlineAt, signal, (guarded) =>
    runWithRetry({
      candidates,
      refusals: narrowed.refusals,
      billing: narrowed.billing,
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

const adapterRequestOf = (model: string, request: CountTokensRequest, input: AdapterInputItem[], fence: string): AdapterRequest => ({
  model,
  input,
  fence,
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
  call: CallIdentity,
): Promise<Counted> => {
  const sentContext = async (): Promise<AdapterContext> => adapterContextOf(services, target, capabilities, signal, attemptNumber, { idempotencyKey: (await recordSendOf(services, call, target, undefined, signal)).callKey, sessionId: undefined });
  const adapterCountWire = target.adapter.countWire;
  if (adapterCountWire !== undefined) return { result: await adapterCountWire.call(target.adapter, wire, await sentContext()), contacted: true };
  const adapterCountTokens = target.adapter.countTokens;
  if (adapterCountTokens === undefined) return { result: estimatedCountOf(wireTokensOf(wire, capabilities.imageTokens)), contacted: false };
  const counted = await adapterCountTokens.call(target.adapter, { model: target.model, input: textOfWire(wire) }, await sentContext());
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
  call: CallIdentity,
): Promise<Counted> => {
  const capabilities = await narrowed.capabilitiesOf(target);
  const fence = request.momonga?.fence ?? services.fenceBoundary(resolved.forAdapter);
  const toolChoiceWire = target.adapter.toolChoiceWire(capabilities, adapterTargetOf(target));
  const counted = asGatewayError(target, () =>
    resolveToolChoice(adapterRequestOf(target.model, request, resolved.forAdapter, fence), capabilities.allowedTools, target.display, toolChoiceWire),
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
        adapterTargetOf(target),
        {
          reasoningOrigin: originOf(services, target),
          capabilities,
          ...(lenientItems === undefined ? {} : { lenientItems }),
        },
      ),
    );
    return countWireOnce(services, target, capabilities, wire, signal, attemptNumber, call);
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
      ? { type: 'message', role: 'user', content: [{ type: 'input_text', text: compactionSummaryText(item.summary, 'model', fence) }] }
      : item,
  );
  const context = adapterContextOf(services, target, capabilities, signal, attemptNumber, { idempotencyKey: (await recordSendOf(services, call, target, undefined, signal)).callKey, sessionId: undefined });
  const result = await adapterCountTokens.call(
    target.adapter,
    {
      model: target.model,
      input: countable,
      ...(request.instructions === undefined ? {} : { instructions: request.instructions }),
      ...(counted.tools === undefined ? {} : { tools: counted.tools }),
      ...(counted.tool_choice === undefined ? {} : { tool_choice: counted.tool_choice }),
    },
    context,
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
  const { router } = services;
  const model = router.resolveRequestModel(request.model, request.momonga?.exact_model === true);
  const chain = router.chainOf(model);
  const named = request.momonga?.target;
  const found = named === undefined ? undefined : chain.find((candidate) => candidate.name === named);
  if (named !== undefined && found === undefined) {
    throw invalidRequest('invalid_target', `model "${router.displayOf(named)}" is not "${router.displayOf(model)}" or one of its fallback models`, MOMONGA_REQUEST_FIELDS.target);
  }
  const candidates = found === undefined ? chain : [found];
  const resolved = resolveInput(services.codec, normalizeInput(request.input));
  const narrowed = await router.narrow(model, candidates, {
    images: inputHasImages(resolved.forAdapter),
    toolChoice: { tools: request.tools, tool_choice: request.tool_choice },
    unknownFields: { keys: Object.keys(unknownFields), operation: 'count_tokens' },
  });
  const call = unkeyedCallOf(services);
  const outcome = await callTargets(services, narrowed.targets, narrowed, signal, deadlineAt, (chosen, attemptNumber, guarded) =>
    countOnTarget(services, chosen, narrowed, request, resolved, guarded, attemptNumber, call),
  );
  return settleCounted(outcome);
};

const withoutCeiling = (momonga: CompactRequest['momonga']): CompactRequest['momonga'] => {
  if (momonga === undefined) return undefined;
  const { max_cost_nano: _ceiling, max_input_tokens: _inputBound, ...rest } = momonga;
  return rest;
};

export type CompactTrace = { runId: string | undefined; sessionId: string | undefined; traceparent: string | undefined; tracestate: string | undefined };

const compactOnce = async (
  services: Services,
  request: CompactRequest,
  unknownFields: UnknownFields,
  signal: AbortSignal,
  deadlineAt: number | undefined,
  trace: CompactTrace,
  call: CallIdentity,
): Promise<CompactResource> => {
  const { router } = services;
  const sizingCall = unkeyedCallOf(services);
  const model = router.resolveRequestModel(request.model, request.momonga?.exact_model === true);
  const targets = router.chainOf(model);
  const resolved = resolveInput(services.codec, normalizeInput(request.input));
  const narrowed = await router.narrow(model, targets, {
    images: inputHasImages(resolved.forAdapter),
    ...(request.momonga?.max_summary_tokens === undefined ? {} : { summaryCap: request.momonga.max_summary_tokens }),
    unknownFields: { keys: Object.keys(unknownFields), operation: 'compact' },
  });
  const supporting = narrowed.targets.filter((target) => target.adapter.compact !== undefined);
  if (supporting.length === 0) {
    throw invalidRequest('capability_unsupported', `"${router.displayOf(model)}" and its fallback models do not support compaction`, 'model');
  }
  const compactRequestFor = (target: TargetRuntime, cap: number): AdapterCompactRequest => ({
    model: target.model,
    input: resolved.forAdapter,
    ...(request.instructions === undefined ? {} : { instructions: request.instructions }),
    momonga: { ...withoutCeiling(request.momonga), fence: request.momonga?.fence ?? services.fenceBoundary(resolved.forAdapter), max_summary_tokens: cap },
  });
  const sizeRefusal: Refusal = {
    stage: REFUSAL_STAGES.inputSize,
    error: invalidRequest('compaction_input_too_large', 'the conversation to summarise does not fit the context window of any target', 'input'),
  };
  const capFor = (capabilities: Capabilities): number =>
    request.momonga?.max_summary_tokens ?? largestSummaryCapFor(capabilities);
  const wireFor = (target: TargetRuntime, capabilities: Capabilities, cap: number): Record<string, unknown> | undefined => {
    const renderCompactWire = target.adapter.renderCompactWire;
    if (renderCompactWire === undefined) return undefined;
    return asGatewayError(target, () =>
      renderCompactWire.call(target.adapter, compactRequestFor(target, cap), adapterTargetOf(target), cap, originOf(services, target), capabilities),
    );
  };
  const fitsWindow = (capabilities: Capabilities, cap: number, counted: CountTokensResult): boolean =>
    counted.input_tokens + counted.error_bound <= summaryRequestInputLimitFor(capabilities, cap);
  const parent =
    services.telemetry === undefined || trace.traceparent === undefined
      ? undefined
      : services.telemetry.propagation.extract({
          traceparent: trace.traceparent,
          ...(trace.tracestate === undefined ? {} : { tracestate: trace.tracestate }),
        });
  const spans = new Map<TargetRuntime, AttemptSpan>();
  const startSpan = (target: TargetRuntime, attemptNumber: number, cap: number | undefined, retryOf?: number): AttemptSpan =>
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
      retryOf,
      targetName: target.name,
      role: COMPACTION_ROLE,
      startedAtMs: services.clock.now(),
      request: { input: resolved.forAdapter, instructions: request.instructions, tools: undefined, fence: request.momonga?.fence ?? services.fenceBoundary(resolved.forAdapter) },
    });
  const failSpan = (span: AttemptSpan, failure: unknown): void => span.fail(errorTypeOf(failure), failure, describeError(failure));
  const outcome = await callTargets(services, supporting, narrowed, signal, deadlineAt, async (target, attemptNumber, guarded) => {
    const compact = target.adapter.compact;
    if (compact === undefined) throw new TypeError(`model "${target.display}" lost its compact capability`);
    let capabilities: Capabilities;
    let cap: number;
    let sent: Sent;
    try {
      capabilities = await narrowed.capabilitiesOf(target);
      cap = outputBoundWithinCostCeiling(
        {
          ceilingNano: request.momonga?.max_cost_nano,
          inputBound: request.momonga?.max_input_tokens,
          visible: capFor(capabilities),
          effort: LOWEST_REASONING_EFFORT,
          smallestAnswer: MIN_SUMMARY_TOKENS,
        },
        target,
        capabilities,
        services.priceTable,
        services.clock.now(),
      );
      const wire = wireFor(target, capabilities, cap);
      if (wire !== undefined && !fitsWindow(capabilities, cap, (await countWireOnce(services, target, capabilities, wire, guarded, attemptNumber, sizingCall)).result)) {
        throw new CandidateRefused(sizeRefusal);
      }
      sent = await recordSendOf(services, call, target, trace.runId, guarded);
    } catch (error) {
      if (error instanceof CandidateRefused || error instanceof CandidateDropped || error instanceof UnprobedTarget) throw error;
      const failure = failureFrom(target.adapter, error, guarded);
      failSpan(startSpan(target, attemptNumber, undefined), failure);
      throw failure;
    }
    const span = startSpan(target, attemptNumber, cap, sent.retryOfSeq);
    try {
      const result = await compact.call(target.adapter, compactRequestFor(target, cap), adapterContextOf(services, target, capabilities, guarded, attemptNumber, { idempotencyKey: sent.callKey, sessionId: trace.sessionId }, span.route));
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
  if (attempt === undefined) throw new TypeError(`model "${outcome.target.display}" answered the compaction without an attempt span`);
  attempt.succeed({
    responseModel: outcome.target.model,
    responseId: resourceId,
    finishReason: 'stop',
    usage: outcome.value.usage,
    usageSource: outcome.value.usageSource,
    ...(outcome.value.cacheWriteInputTokens === undefined ? {} : { cacheWriteInputTokens: outcome.value.cacheWriteInputTokens }),
    output: [],
    fallbackCauses: outcome.fallbackCauses,
  });
  const item: CompactionItem = {
    type: 'compaction',
    id: identifier(services, 'cmp'),
    encrypted_content: services.codec.encode(outcome.value.summary),
  };
  const pricing = modelCostOf({
    provider: outcome.target.provider,
    model: outcome.target.model,
    billing: outcome.target.billing,
    usage: outcome.value.usage,
    usageSource: outcome.value.usageSource,
    cacheWriteInputTokens: outcome.value.cacheWriteInputTokens,
    at: attempt.startedAtMs,
    table: services.priceTable,
  });
  const wire = wireUsageOf(outcome.value.usage);
  return {
    id: resourceId,
    object: 'response.compaction',
    output: [item],
    created_at: Math.floor(services.clock.now() / 1000),
    usage: wire.usage,
    momonga: {
      target: outcome.target.name,
      ...(outcome.value.cacheWriteInputTokens === undefined ? {} : { cacheWriteInputTokens: outcome.value.cacheWriteInputTokens }),
      ...(wire.cacheReadNotReported === undefined ? {} : { cacheReadNotReported: wire.cacheReadNotReported }),
      ...pricingFieldsOf(pricing),
    },
  };
};

export const createUnaryService = (services: GatewayServices, validator: RequestValidator, inFlight: WorkRegistry, admitNewCall: () => void): UnaryService => {
  const inflight = new Map<string, InflightCompaction>();
  const active = new Set<InflightCompaction>();

  const clearDetachTimer = (entry: InflightCompaction): void => {
    if (entry.detachTimer === undefined) return;
    services.timers.clearTimeout(entry.detachTimer);
    entry.detachTimer = undefined;
  };

  const attach = (entry: InflightCompaction): void => {
    entry.subscribers += 1;
    entry.work.subscribers(entry.subscribers);
    clearDetachTimer(entry);
  };

  const detach = (entry: InflightCompaction): void => {
    entry.subscribers -= 1;
    entry.work.subscribers(entry.subscribers);
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

  const compactKeyed = async (
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
    const digest = sha256Hex(canonicalJson(request.momonga === undefined ? request : { ...request, momonga: withoutCeiling(request.momonga) }));
    const joinRunning = (): Promise<CompactResource> | undefined => {
      const running = inflight.get(key);
      if (running === undefined) return undefined;
      if (running.digest !== digest) throw reusedError(key);
      return wait(running, signal, deadlineAt);
    };
    const runningBeforeRead = joinRunning();
    if (runningBeforeRead !== undefined) return runningBeforeRead;
    const stored = await services.store.getCompaction(key, signal);
    const runningAfterRead = joinRunning();
    if (runningAfterRead !== undefined) return runningAfterRead;
    if (stored !== undefined) {
      if (services.clock.now() < stored.expiresAtMs) {
        if (stored.digest !== digest) throw reusedError(key);
        return stored.resource;
      }
      await services.store.deleteCompaction(key, signal);
      const runningAfterDelete = joinRunning();
      if (runningAfterDelete !== undefined) return runningAfterDelete;
    }
    if (services.closeSignal.aborted) throw gatewayClosedError();
    admitNewCall();
    const controller = new AbortController();
    const entry: InflightCompaction = {
      digest,
      controller,
      subscribers: 0,
      detachTimer: undefined,
      settled: false,
      work: inFlight.beginWork(),
      promise: Promise.resolve().then(async () => {
        try {
          const resource = await withPinnedServices(services, controller.signal, (pinned) => compactOnce(pinned, request, unknownFields, controller.signal, SHARED_WORK_HAS_NO_CALLER_DEADLINE, trace, { kind: 'keyed', key, digest }));
          if (isRunCancelled(controller.signal.reason)) throw controller.signal.reason;
          const now = services.clock.now();
          await services.store.commitCompaction({ key, digest, resource, createdAtMs: now, expiresAtMs: now + services.config.idempotency.ttlMs }, controller.signal);
          return resource;
        } finally {
          entry.settled = true;
          entry.work.end();
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
    countTokens: (rawBody, signal, deadlineHeader) => {
      admitNewCall();
      return withPinnedServices(services, signal, (pinned) => countTokens(pinned, validator, rawBody, signal, deadlineHeader));
    },
    compact: (rawBody, signal, deadlineHeader, idempotencyKeyHeader, trace) => {
      const key = parseIdempotencyKey(idempotencyKeyHeader);
      if (key !== undefined) return compactKeyed(rawBody, key, signal, deadlineHeader, trace);
      admitNewCall();
      const request = validator.parseCompact(rawBody);
      const unknownFields = validator.unknownCompactFields(rawBody);
      const deadlineAt = parseDeadlineHeader(deadlineHeader, services.clock.now());
      const compactSignal = AbortSignal.any([signal, services.closeSignal]);
      return withPinnedServices(services, compactSignal, (pinned) => compactOnce(pinned, request, unknownFields, compactSignal, deadlineAt, trace, unkeyedCallOf(pinned)));
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
    activeCount: () => active.size,
  };
};
