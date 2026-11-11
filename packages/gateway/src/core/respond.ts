import { newCallId, uuidv7 } from '@momonga/foundation';
import { describeError } from './describe-error.ts';
import { redactedError } from './guarded-adapter.ts';
import type {
  AdapterRequest,
  Capabilities,
  ClassifiedError,
  CreateResponseBody,
  ErrorType,
  FailedResponseResource,
  InputItem,
  ItemField,
  MomongaResponseExtension,
  PromptCacheCounts,
  ResponseError,
  ResponseResource,
  JsonReplyPath,
  SchemaNarrowing,
  StreamEvent,
  Usage,
  UsageSource,
} from '@momonga/protocol';
import { modelCostOf, pricingFieldsOf } from './model-cost.ts';
import { outputBoundWithinCostCeiling } from './quote.ts';
import { MOMONGA_SPAN_NOTES, TERMINAL_STREAM_EVENT_TYPES, carriesOutput, isReasoningEffort, wireUsageOf } from '@momonga/protocol';
import { startAttemptSpan } from './attempt-span.ts';
import type { AttemptSpan, BilledUsage, TraceParent } from './attempt-span.ts';
import { breakerVerdictOf } from './breaker-verdict.ts';
import type { BreakerVerdict } from './breaker-verdict.ts';
import { armDeadline } from './deadline.ts';
import { ClientDisconnectedError, GatewayError, isGatewayClosed, isRunCancelled } from './errors.ts';
import { estimateInputTokens, estimateOutputTokens, estimatedUsage, tokensForText } from './estimate.ts';
import { inputHasImages, inputKindsOf, resolveInput } from './input.ts';
import { StreamFailure } from './stream-failure.ts';
import type { ConnectionResponses, ResolvedInput } from './input.ts';
import { baseResource } from './resource.ts';
import { UpstreamFailure, emptyStreamFailure, failureFrom, runWithRetry } from './retry.ts';
import type { RetryOutcome } from './retry.ts';
import type { Release } from './admission.ts';
import { adapterContextOf } from './adapter-context.ts';
import type { Narrowed, TargetRuntime } from './router.ts';
import { CandidateDropped, CandidateRefused, UnprobedTarget } from './candidate-refusal.ts';
import type { RunControl } from './run.ts';
import type { Services } from './services.ts';
import type { CommitRequest } from './store.ts';
import type { UnknownFields } from './unknown-fields.ts';
import { upstreamCallKey } from './upstream-call-key.ts';
import type { CallIdentity } from './upstream-call-key.ts';

export type ResponseJob = {
  model: string;
  body: CreateResponseBody;
  unknownFields: UnknownFields;
  clientInput: InputItem[];
  idempotency: { key: string; digest: string } | undefined;
  deadlineAt: number | undefined;
  parent: TraceParent | undefined;
  runId: string | undefined;
  step: number | undefined;
  role: string;
  connection?: ConnectionResponses;
};

type Opened = {
  iterator: AsyncIterator<StreamEvent>;
  held: StreamEvent[];
  release: Release;
  span: AttemptSpan;
  capabilities: Capabilities;
};

type Pulled = { kind: 'event'; event: StreamEvent } | { kind: 'failed'; error: unknown };

type Interruption = {
  code: string;
  message: string;
  type: ErrorType;
  spanType: string;
  error: unknown;
  verdict: BreakerVerdict;
  retryable: boolean;
};

const SMALLEST_ANSWER_TOKENS = 1;

const OPENING_EVENT_TYPES: ReadonlySet<string> = new Set(['response.created', 'response.queued', 'response.in_progress']);
const TERMINAL_TYPES: ReadonlySet<string> = new Set(TERMINAL_STREAM_EVENT_TYPES);

type TerminalEvent = Extract<StreamEvent, { response: ResponseResource }>;

const cacheMarksFor = (job: ResponseJob, resolved: ResolvedInput): PromptCacheCounts | undefined => {
  const marks = job.body.momonga?.cache;
  if (marks === undefined) return undefined;
  const offset = resolved.stored.length - job.clientInput.length;
  return {
    stable: marks.stable + offset,
    fixed: marks.fixed + offset,
    ...(marks.previousHistory === undefined ? {} : { previousHistory: marks.previousHistory + offset }),
    history: marks.history + offset,
  };
};

const adapterRequestFor = (job: ResponseJob, resolved: ResolvedInput, target: TargetRuntime, visibleBound: number | undefined): AdapterRequest => {
  const { body } = job;
  const cacheMarks = cacheMarksFor(job, resolved);
  return {
    model: target.model,
    input: resolved.forAdapter,
    ...(body.instructions === undefined || body.instructions === null ? {} : { instructions: body.instructions }),
    ...(body.tools === undefined || body.tools === null || body.tools.length === 0 ? {} : { tools: body.tools }),
    ...(body.tool_choice === undefined || body.tool_choice === null ? {} : { tool_choice: body.tool_choice }),
    ...(body.parallel_tool_calls === undefined || body.parallel_tool_calls === null
      ? {}
      : { parallel_tool_calls: body.parallel_tool_calls }),
    ...(visibleBound === undefined ? {} : { max_output_tokens: visibleBound }),
    ...(body.temperature === undefined ? {} : { temperature: body.temperature }),
    ...(body.top_p === undefined ? {} : { top_p: body.top_p }),
    ...(body.frequency_penalty === undefined ? {} : { frequency_penalty: body.frequency_penalty }),
    ...(body.presence_penalty === undefined ? {} : { presence_penalty: body.presence_penalty }),
    ...(isReasoningEffort(body.reasoning?.effort) ? { reasoning_effort: body.reasoning.effort } : {}),
    ...(body.text === undefined || body.text === null ? {} : { text: body.text }),
    ...(body.prompt_cache_key === undefined || body.prompt_cache_key === null ? {} : { promptCacheKey: body.prompt_cache_key }),
    ...(cacheMarks === undefined ? {} : { cacheMarks }),
    ...(Object.keys(job.unknownFields).length === 0 ? {} : { unknownFields: job.unknownFields }),
  };
};

export const errorTypeOf = (failure: unknown): string => {
  if (failure instanceof UpstreamFailure) return failure.classified.error.type;
  if (failure instanceof GatewayError) return failure.body.type;
  return 'cancelled';
};

const thrownSpanType = (error: unknown): string => (error instanceof GatewayError ? error.body.type : 'server_error');

const classifiedFailure = (adapter: TargetRuntime['adapter'], error: ResponseError): ClassifiedError => {
  const classified = adapter.classify(new StreamFailure(error.code, error.type ?? 'server_error', error.message));
  return error.retryAfterMs === undefined ? classified : { ...classified, retryAfterMs: error.retryAfterMs };
};

const failureBeforeOutput = (event: StreamEvent, adapter: TargetRuntime['adapter']): UpstreamFailure | undefined => {
  if (!TERMINAL_TYPES.has(event.type)) return undefined;
  const terminal = event as TerminalEvent;
  const violation = protocolViolationOf(terminal);
  if (violation !== undefined) {
    return new UpstreamFailure({
      retryable: true,
      error: { type: 'model_error', code: 'upstream_protocol_error', message: `the upstream violated the event protocol: ${violation}`, param: null },
    });
  }
  if (terminal.type !== 'response.failed') return undefined;
  const classified = classifiedFailure(adapter, terminal.response.error);
  return classified.retryable ? new UpstreamFailure(classified) : undefined;
};

const openAttempt = async (
  services: Services,
  job: ResponseJob,
  resolved: ResolvedInput,
  target: TargetRuntime,
  narrowed: Narrowed,
  attemptNumber: number,
  signal: AbortSignal,
  call: CallIdentity,
): Promise<Opened> => {
  const release = await target.gate.acquire(signal);
  const startSpan = (retryOf?: number): AttemptSpan =>
    startAttemptSpan({
      telemetry: services.telemetry,
      parent: job.parent,
      providerName: target.provider,
      billing: target.billing,
      requestModel: target.model,
      maxTokens: visibleBound,
      stream: job.body.stream === true,
      runId: job.runId,
      step: job.step,
      attempt: attemptNumber,
      retryOf,
      targetName: target.name,
      role: job.role,
      startedAtMs: services.clock.now(),
      request: { input: resolved.forAdapter, instructions: job.body.instructions, tools: job.body.tools },
    });
  const callKey = upstreamCallKey(call, target.name);
  const failBeforeSend = (error: unknown): never => {
    release();
    if (error instanceof CandidateRefused || error instanceof CandidateDropped || error instanceof UnprobedTarget) throw error;
    const failure = failureFrom(target.adapter, error, signal);
    startSpan().fail(errorTypeOf(failure), failure, describeError(failure));
    throw failure;
  };
  let visibleBound: number | undefined;
  const capabilities = await narrowed.capabilitiesOf(target).catch(failBeforeSend);
  try {
    visibleBound = outputBoundWithinCostCeiling(
      {
        ceilingNano: job.body.momonga?.max_cost_nano,
        inputBound: job.body.momonga?.max_input_tokens,
        visible: job.body.max_output_tokens ?? undefined,
        effort: isReasoningEffort(job.body.reasoning?.effort) ? job.body.reasoning.effort : undefined,
        smallestAnswer: SMALLEST_ANSWER_TOKENS,
      },
      target,
      capabilities,
      services.priceTable,
      services.clock.now(),
    );
  } catch (refusal) {
    release();
    throw refusal;
  }
  let retryOfSeq: number | undefined;
  try {
    retryOfSeq = services.store.recordSend({ callKey, target: target.name, runId: job.runId ?? null, step: job.step ?? null, sentAtMs: services.clock.now() }).retryOfSeq;
  } catch (error) {
    failBeforeSend(error);
  }
  const span = startSpan(retryOfSeq);
  try {
    const stream = target.adapter.create(adapterRequestFor(job, resolved, target, visibleBound), adapterContextOf(services, target, capabilities, signal, attemptNumber, callKey, span.route));
    const iterator = stream[Symbol.asyncIterator]();
    const held: StreamEvent[] = [];
    for (;;) {
      const step = await iterator.next();
      if (step.done === true) throw emptyStreamFailure();
      held.push(step.value);
      const failure = failureBeforeOutput(step.value, target.adapter);
      if (failure !== undefined) throw failure;
      if (carriesOutput(step.value) || TERMINAL_TYPES.has(step.value.type)) break;
    }
    span.committed();
    return { iterator, held, release, span, capabilities };
  } catch (error) {
    release();
    const failure = failureFrom(target.adapter, error, signal);
    span.fail(errorTypeOf(failure), failure, describeError(failure));
    throw failure;
  }
};

const describeInterruption = (target: TargetRuntime, error: unknown, signal: AbortSignal): Interruption => {
  const failure = failureFrom(target.adapter, error, signal);
  if (failure instanceof UpstreamFailure) {
    return {
      code: 'stream_interrupted',
      message: `the upstream stream was interrupted: ${failure.classified.error.message}`,
      type: failure.classified.error.type,
      spanType: failure.classified.error.type,
      error: failure,
      verdict: breakerVerdictOf(failure.classified.error.type, failure.classified.error.code),
      retryable: failure.classified.retryable,
    };
  }
  if (failure instanceof GatewayError) {
    return {
      code: failure.body.code ?? failure.body.type,
      message: failure.message,
      type: failure.body.type,
      spanType: failure.body.type,
      error: failure,
      verdict: 'neutral',
      retryable: isGatewayClosed(failure),
    };
  }
  return {
    code: 'client_disconnected',
    message: 'the client disconnected before the response completed',
    type: 'server_error',
    spanType: 'cancelled',
    error: failure,
    verdict: 'neutral',
    retryable: false,
  };
};

const protocolViolationOf = (event: TerminalEvent): string | undefined => {
  const response: ResponseResource | null | undefined = event.response;
  if (typeof response !== 'object' || response === null) return `${event.type} carries no response object`;
  if (!Array.isArray(response.output)) return `${event.type} carries a response without an output array`;
  if (event.type === 'response.failed' && (response.error as ResponseError | null) === null) {
    return 'response.failed carries no error';
  }
  return undefined;
};

const protocolInterruption = (message: string): Interruption => ({
  code: 'upstream_protocol_error',
  message: `the upstream violated the event protocol: ${message}`,
  type: 'model_error',
  spanType: 'model_error',
  error: new Error(message),
  verdict: 'failure',
  retryable: true,
});

const finishReasonOf = (resource: ResponseResource): string =>
  resource.status === 'completed' ? 'stop' : (resource.incomplete_details?.reason ?? resource.status);

const orderedItems = (items: Map<number, ItemField>): ItemField[] =>
  [...items.entries()].sort(([left], [right]) => left - right).map(([, item]) => item);

type RelayProgress = { concluded: boolean; thrown: { error: unknown } | undefined };

const verdictOfThrown = (error: unknown): BreakerVerdict =>
  error instanceof GatewayError ? breakerVerdictOf(error.body.type, error.body.code ?? null) : 'failure';

async function* relay(
  services: Services,
  job: ResponseJob,
  resolved: ResolvedInput,
  outcome: RetryOutcome<Opened>,
  control: RunControl,
): AsyncGenerator<StreamEvent> {
  const progress: RelayProgress = { concluded: false, thrown: undefined };
  const { value: opened } = outcome;
  try {
    yield* relaySteps(services, job, resolved, outcome, control, progress);
  } catch (error) {
    if (!control.signal.aborted) progress.thrown = { error };
    throw error;
  } finally {
    opened.release();
    if (!progress.concluded) {
      const { thrown } = progress;
      outcome.settle(thrown === undefined ? 'neutral' : verdictOfThrown(thrown.error));
      try {
        await opened.iterator.return?.();
      } catch (error) {
        opened.span.note(MOMONGA_SPAN_NOTES.adapterCleanupError, describeError(error));
      }
      if (thrown === undefined) {
        opened.span.fail('cancelled', control.signal.reason ?? new ClientDisconnectedError(), 'the response stream was closed before it completed');
      } else {
        opened.span.fail(thrownSpanType(thrown.error), thrown.error, describeError(thrown.error));
      }
    }
  }
}

async function* relaySteps(
  services: Services,
  job: ResponseJob,
  resolved: ResolvedInput,
  outcome: RetryOutcome<Opened>,
  control: RunControl,
  progress: RelayProgress,
): AsyncGenerator<StreamEvent> {
  const { signal } = control;
  const { value: opened, target, attempts, fallbackFrom, fallbackCauses } = outcome;
  const { clock } = services;
  const responseId = `resp_${uuidv7(clock).replaceAll('-', '')}`;
  const base = baseResource(job.body, { id: responseId, model: target.model, createdAtSeconds: Math.floor(clock.now() / 1000) });
  const callIds = new Map<string, string>();
  const rewriteItem = (item: ItemField): ItemField => {
    if (item.type !== 'function_call') return item;
    let callId = callIds.get(item.call_id);
    if (callId === undefined) {
      callId = newCallId(clock);
      callIds.set(item.call_id, callId);
    }
    return { ...item, call_id: callId };
  };
  let sequence = 0;
  const nextSequence = (): number => {
    const value = sequence;
    sequence += 1;
    return value;
  };

  const doneItems = new Map<number, ItemField>();
  const arrivingText = new Map<number, string>();
  let upstreamTerminal: TerminalEvent | undefined;
  let interruption: Interruption | undefined;
  let iteratorOpen = false;

  const pull = async (): Promise<Pulled | { kind: 'ended' }> => {
    try {
      const step = await opened.iterator.next();
      return step.done === true ? { kind: 'ended' } : { kind: 'event', event: step.value };
    } catch (error) {
      return { kind: 'failed', error };
    }
  };

  try {
    yield { type: 'response.created', sequence_number: nextSequence(), response: base };
    yield { type: 'response.in_progress', sequence_number: nextSequence(), response: base };
    const queue = [...opened.held];
    let event: StreamEvent | undefined = queue.shift();
    for (;;) {
      if (event === undefined) {
        const pulled = await pull();
        if (pulled.kind === 'event') {
          event = pulled.event;
        } else {
          interruption =
            pulled.kind === 'failed'
              ? describeInterruption(target, pulled.error, signal)
              : {
                  code: 'stream_interrupted',
                  message: 'the upstream stream ended before sending a terminal event',
                  type: 'server_error',
                  spanType: 'server_error',
                  error: new Error('upstream stream ended without a terminal event'),
                  verdict: 'failure',
                  retryable: true,
                };
          break;
        }
      }
      if (TERMINAL_TYPES.has(event.type)) {
        const terminalEvent = event as TerminalEvent;
        const violation = protocolViolationOf(terminalEvent);
        if (violation === undefined) upstreamTerminal = terminalEvent;
        else interruption = protocolInterruption(violation);
        iteratorOpen = true;
        break;
      }
      if (!OPENING_EVENT_TYPES.has(event.type)) {
        let forwarded: StreamEvent = event;
        if (forwarded.type === 'response.output_item.added' || forwarded.type === 'response.output_item.done') {
          forwarded = { ...forwarded, item: rewriteItem(forwarded.item) };
          if (forwarded.type === 'response.output_item.done') {
            doneItems.set(forwarded.output_index, forwarded.item);
            arrivingText.delete(forwarded.output_index);
          }
        } else if ('delta' in forwarded && typeof forwarded.delta === 'string' && 'output_index' in forwarded && typeof forwarded.output_index === 'number') {
          arrivingText.set(forwarded.output_index, `${arrivingText.get(forwarded.output_index) ?? ''}${forwarded.delta}`);
        }
        yield { ...forwarded, sequence_number: nextSequence() };
      }
      event = queue.shift();
    }
  } finally {
    opened.release();
  }

  if (iteratorOpen) {
    try {
      await opened.iterator.return?.();
    } catch (error) {
      opened.span.note(MOMONGA_SPAN_NOTES.adapterCleanupError, describeError(error));
    }
  }

  const momongaFor = (
    usageSource: UsageSource,
    contextInputTokens?: number,
    billed?: BilledUsage,
    retryable?: boolean,
    schemaNarrowings?: SchemaNarrowing[],
    jsonReply?: JsonReplyPath,
    cacheReadNotReported?: true,
  ): MomongaResponseExtension => {
    const pricing =
      billed === undefined
        ? undefined
        : modelCostOf({
            provider: target.provider,
            model: target.model,
            billing: target.billing,
            usage: billed.usage,
            usageSource: billed.usageSource,
            cacheWriteInputTokens: billed.cacheWriteInputTokens,
            at: opened.span.startedAtMs,
            table: services.priceTable,
          });
    return {
      model: job.model,
      target: target.name,
      counter: target.counter,
      attempts,
      ...(fallbackFrom.length === 0 ? {} : { fallbackFrom, fallbackCauses }),
      ...(schemaNarrowings === undefined ? {} : { schemaNarrowings }),
      ...(jsonReply === undefined ? {} : { jsonReply }),
      usageSource,
      ...(contextInputTokens === undefined ? {} : { contextInputTokens }),
      ...(billed?.cacheWriteInputTokens === undefined ? {} : { cacheWriteInputTokens: billed.cacheWriteInputTokens }),
      ...(cacheReadNotReported === undefined ? {} : { cacheReadNotReported }),
      ...(pricing === undefined ? {} : pricingFieldsOf(pricing)),
      ...(retryable === undefined ? {} : { retryable }),
    };
  };
  const completedAt = Math.floor(clock.now() / 1000);

  const billedOf = (reported: Usage | null, output: readonly ItemField[], cacheWriteInputTokens: number | undefined): BilledUsage => {
    if (reported !== null) return { usage: reported, usageSource: 'reported', cacheWriteInputTokens };
    const arrived = estimateOutputTokens(output) + [...arrivingText.values()].reduce((sum, text) => sum + tokensForText(text), 0);
    const input = estimateInputTokens({ input: resolved.forAdapter, instructions: job.body.instructions, tools: job.body.tools ?? undefined }, opened.capabilities.imageTokens);
    return { usage: estimatedUsage(input, arrived), usageSource: 'estimated', cacheWriteInputTokens };
  };

  const failedTerminal = (error: ResponseError, output: ItemField[], retryable: boolean, billed: BilledUsage): StreamEvent => {
    const plan = target.servedAccount();
    const wire = wireUsageOf(billed.usage);
    const response: FailedResponseResource = {
      ...base,
      status: 'failed',
      completed_at: completedAt,
      output,
      usage: wire.usage,
      error: plan === undefined ? error : { ...error, plan },
      momonga: momongaFor(billed.usageSource, undefined, billed, retryable, undefined, undefined, wire.cacheReadNotReported),
    };
    return { type: 'response.failed', sequence_number: nextSequence(), response };
  };

  if (interruption !== undefined) {
    outcome.settle(interruption.verdict);
    if (interruption.verdict === 'failure') target.lastFailure = { code: interruption.code, message: interruption.message };
    const arrived = orderedItems(doneItems);
    const billed = billedOf(null, arrived, undefined);
    opened.span.fail(interruption.spanType, interruption.error, interruption.message, billed);
    progress.concluded = true;
    yield failedTerminal({ code: interruption.code, message: interruption.message, type: interruption.type }, arrived, interruption.retryable, billed);
    return;
  }

  const terminalEvent = upstreamTerminal as TerminalEvent;
  const upstream = terminalEvent.response;
  const upstreamOutput = upstream.output.map(rewriteItem);

  if (terminalEvent.type === 'response.failed') {
    const upstreamError = terminalEvent.response.error;
    const classified = classifiedFailure(target.adapter, upstreamError);
    const { error } = classified;
    outcome.settle(classified.verdict ?? breakerVerdictOf(error.type, error.code));
    const billed = billedOf(upstream.usage, upstreamOutput, upstream.cacheWriteInputTokens);
    opened.span.fail(error.type, new Error(error.message), error.message, billed);
    progress.concluded = true;
    yield failedTerminal({ code: error.code ?? upstreamError.code, message: error.message, type: error.type }, upstreamOutput, classified.retryable, billed);
    return;
  }

  const billed = billedOf(upstream.usage, upstreamOutput, upstream.cacheWriteInputTokens);
  const { usage, usageSource } = billed;
  const wire = wireUsageOf(usage);
  const status = terminalEvent.type === 'response.completed' ? 'completed' : 'incomplete';
  const resource: ResponseResource = {
    ...base,
    status,
    completed_at: completedAt,
    incomplete_details: upstream.incomplete_details,
    output: upstreamOutput,
    usage: wire.usage,
    momonga: momongaFor(
      usageSource,
      upstream.contextInputTokens,
      billed,
      undefined,
      upstream.schemaNarrowings,
      upstream.jsonReply,
      wire.cacheReadNotReported,
    ),
  };
  const terminal: StreamEvent = {
    type: terminalEvent.type,
    sequence_number: nextSequence(),
    response: resource,
  };

  if (isRunCancelled(signal.reason)) {
    const cancelled = signal.reason as GatewayError;
    outcome.settle('neutral');
    opened.span.fail('cancelled', cancelled, cancelled.message, billed);
    progress.concluded = true;
    yield failedTerminal({ code: 'run_cancelled', message: cancelled.message, type: 'server_error' }, resource.output, false, billed);
    return;
  }

  const priorFrames = control.frames();
  const commit: CommitRequest = {
    recordedAtMs: clock.now(),
    idempotencyExpiredBeforeMs: clock.now() - services.config.idempotency.ttlMs,
    ...(job.body.store === true ? { response: { id: responseId, input: resolved.stored, output: resource.output } } : {}),
    ...(job.idempotency === undefined || priorFrames === undefined
      ? {}
      : { idempotency: { key: job.idempotency.key, digest: job.idempotency.digest, frames: [...priorFrames, terminal] } }),
  };
  let commitFailure: unknown;
  if (commit.response !== undefined || commit.idempotency !== undefined) {
    try {
      services.store.commit(commit);
    } catch (error) {
      commitFailure = error;
    }
  }
  if (commitFailure !== undefined) {
    const message = `the gateway could not persist the response: ${redactedError(services.redactor, commitFailure).message}`;
    outcome.settle('neutral');
    opened.span.fail('server_error', commitFailure, message, billed);
    progress.concluded = true;
    yield failedTerminal({ code: 'internal_error', message, type: 'server_error' }, resource.output, false, billed);
    return;
  }
  job.connection?.remember(responseId, { input: resolved.stored, output: resource.output });
  outcome.settle('success');
  opened.span.succeed({
    responseModel: target.model,
    responseId,
    finishReason: finishReasonOf(resource),
    usage,
    usageSource,
    ...(upstream.cacheWriteInputTokens === undefined ? {} : { cacheWriteInputTokens: upstream.cacheWriteInputTokens }),
    output: resource.output,
    fallbackCauses,
  });
  progress.concluded = true;
  yield terminal;
}

export async function* executeResponse(services: Services, job: ResponseJob, control: RunControl): AsyncGenerator<StreamEvent> {
  const { signal } = control;
  const resolved = resolveInput(services.store, services.codec, job.body.previous_response_id, job.clientInput, job.connection);
  const narrowed = await services.router.candidates(job.model, {
    tools: (job.body.tools?.length ?? 0) > 0,
    images: inputHasImages(resolved.forAdapter),
    inputKinds: inputKindsOf(resolved.forAdapter, job.body.tools),
    sampling: job.body,
    outputBound: job.body.max_output_tokens !== undefined && job.body.max_output_tokens !== null,
    toolChoice: { tools: job.body.tools, tool_choice: job.body.tool_choice },
    unknownFields: { keys: Object.keys(job.unknownFields), operation: 'create' },
  });
  const disarm = armDeadline(services, job.deadlineAt, control.abort);
  const call: CallIdentity = job.idempotency === undefined ? { kind: 'unkeyed', nonce: uuidv7(services.clock) } : { kind: 'keyed', ...job.idempotency };
  try {
    const outcome = await runWithRetry({
      candidates: narrowed.targets,
      refusals: narrowed.refusals,
      billing: narrowed.billing,
      policy: { ...services.config.retry, random: services.random, clock: services.clock, timers: services.timers },
      signal,
      deadlineAt: job.deadlineAt,
      attempt: (target, attemptNumber) => openAttempt(services, job, resolved, target, narrowed, attemptNumber, signal, call),
    });
    yield* relay(services, job, resolved, outcome, control);
  } finally {
    disarm();
  }
}
