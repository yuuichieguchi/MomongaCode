import { uuidv7 } from '@momonga/foundation';
import type {
  AdapterRequest,
  Capabilities,
  CreateResponseBody,
  ErrorType,
  FailedResponseResource,
  InputItem,
  ItemField,
  MomongaResponseExtension,
  PromptCacheCounts,
  ResponseError,
  ResponseResource,
  SchemaNarrowing,
  StreamEvent,
  Usage,
  UsageSource,
} from '@momonga/protocol';
import { modelCostOf } from './model-cost.ts';
import { TERMINAL_STREAM_EVENT_TYPES, carriesOutput, isReasoningEffort } from '@momonga/protocol';
import { startAttemptSpan } from './attempt-span.ts';
import type { AttemptSpan, TraceParent } from './attempt-span.ts';
import { breakerVerdictOf, retryableFailureOf } from './breaker-verdict.ts';
import type { BreakerVerdict } from './breaker-verdict.ts';
import { armDeadline } from './deadline.ts';
import { ClientDisconnectedError, GatewayError, isGatewayClosed, isRunCancelled } from './errors.ts';
import { estimateInputTokens, estimateOutputTokens, estimatedUsage } from './estimate.ts';
import { inputHasImages, resolveInput } from './input.ts';
import type { ConnectionResponses, ResolvedInput } from './input.ts';
import { baseResource } from './resource.ts';
import { UpstreamFailure, emptyStreamFailure, failureFrom, runWithRetry } from './retry.ts';
import type { RetryOutcome } from './retry.ts';
import type { Release } from './admission.ts';
import { adapterContextOf } from './adapter-context.ts';
import type { Narrowed, TargetRuntime } from './router.ts';
import { CandidateRefused, UnprobedTarget } from './candidate-refusal.ts';
import type { RunControl } from './run.ts';
import type { Services } from './services.ts';
import type { CommitRequest } from './store.ts';
import type { UnknownFields } from './unknown-fields.ts';

export type ResponseJob = {
  alias: string;
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

const adapterRequestFor = (job: ResponseJob, resolved: ResolvedInput, target: TargetRuntime): AdapterRequest => {
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
    ...(body.max_output_tokens === undefined ? {} : { max_output_tokens: body.max_output_tokens }),
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

export const messageOf = (failure: unknown): string => (failure instanceof Error ? failure.message : String(failure));

const failureBeforeOutput = (event: StreamEvent): UpstreamFailure | undefined => {
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
  const { error } = terminal.response;
  const type = error.type ?? 'server_error';
  if (!retryableFailureOf(type, error.code)) return undefined;
  return new UpstreamFailure({
    retryable: true,
    ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
    error: { type, code: error.code, message: error.message, param: null },
  });
};

const openAttempt = async (
  services: Services,
  job: ResponseJob,
  resolved: ResolvedInput,
  target: TargetRuntime,
  narrowed: Narrowed,
  attemptNumber: number,
  signal: AbortSignal,
): Promise<Opened> => {
  const release = await target.gate.acquire(signal);
  const startSpan = (): AttemptSpan =>
    startAttemptSpan({
      telemetry: services.telemetry,
      parent: job.parent,
      providerName: target.provider,
      billing: target.billing,
      requestModel: target.model,
      maxTokens: job.body.max_output_tokens ?? undefined,
      stream: job.body.stream === true,
      runId: job.runId,
      step: job.step,
      attempt: attemptNumber,
      targetName: target.name,
      role: job.role,
      startedAtMs: services.clock.now(),
      request: { input: resolved.forAdapter, instructions: job.body.instructions, tools: job.body.tools },
    });
  let capabilities: Capabilities;
  try {
    capabilities = await narrowed.capabilitiesOf(target);
  } catch (error) {
    release();
    if (error instanceof CandidateRefused || error instanceof UnprobedTarget) throw error;
    const failure = failureFrom(target.adapter, error, signal);
    const failed = startSpan();
    failed.fail(errorTypeOf(failure), failure, messageOf(failure));
    throw failure;
  }
  const span = startSpan();
  try {
    const stream = target.adapter.create(adapterRequestFor(job, resolved, target), adapterContextOf(services, target, capabilities, signal, attemptNumber));
    const iterator = stream[Symbol.asyncIterator]();
    const held: StreamEvent[] = [];
    for (;;) {
      const step = await iterator.next();
      if (step.done === true) throw emptyStreamFailure();
      held.push(step.value);
      const failure = failureBeforeOutput(step.value);
      if (failure !== undefined) throw failure;
      if (carriesOutput(step.value) || TERMINAL_TYPES.has(step.value.type)) break;
    }
    span.committed();
    return { iterator, held, release, span, capabilities };
  } catch (error) {
    release();
    const failure = failureFrom(target.adapter, error, signal);
    span.fail(errorTypeOf(failure), failure, messageOf(failure));
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

const messageOfError = (error: unknown): string => (error instanceof Error ? error.message : String(error));

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
        opened.span.note('momonga.adapter_cleanup_error', messageOfError(error));
      }
      if (thrown === undefined) {
        opened.span.fail('cancelled', control.signal.reason ?? new ClientDisconnectedError(), 'the response stream was closed before it completed');
      } else {
        opened.span.fail(thrownSpanType(thrown.error), thrown.error, messageOf(thrown.error));
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
      callId = `call_${uuidv7(clock).replaceAll('-', '')}`;
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
          if (forwarded.type === 'response.output_item.done') doneItems.set(forwarded.output_index, forwarded.item);
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
      opened.span.note('momonga.adapter_cleanup_error', messageOfError(error));
    }
  }

  const momongaFor = (
    usageSource: UsageSource,
    contextInputTokens?: number,
    billed?: { usage: Usage; cacheWriteInputTokens: number | undefined },
    retryable?: boolean,
    schemaNarrowings?: SchemaNarrowing[],
  ): MomongaResponseExtension => {
    const cost =
      billed === undefined || services.priceTable === undefined
        ? null
        : modelCostOf({
            provider: target.provider,
            model: target.model,
            billing: target.billing,
            usage: billed.usage,
            cacheWriteInputTokens: billed.cacheWriteInputTokens,
            at: opened.span.startedAtMs,
            table: services.priceTable,
          });
    return {
      alias: job.alias,
      target: target.name,
      counter: target.counter,
      attempts,
      ...(fallbackFrom.length === 0 ? {} : { fallbackFrom, fallbackCauses }),
      ...(schemaNarrowings === undefined ? {} : { schemaNarrowings }),
      usageSource,
      ...(contextInputTokens === undefined ? {} : { contextInputTokens }),
      ...(billed?.cacheWriteInputTokens === undefined ? {} : { cacheWriteInputTokens: billed.cacheWriteInputTokens }),
      ...(cost === null ? {} : { cost }),
      ...(retryable === undefined ? {} : { retryable }),
    };
  };
  const completedAt = Math.floor(clock.now() / 1000);

  const failedTerminal = (error: ResponseError, output: ItemField[], retryable: boolean): StreamEvent => {
    const response: FailedResponseResource = {
      ...base,
      status: 'failed',
      completed_at: completedAt,
      output,
      error,
      momonga: momongaFor('estimated', undefined, undefined, retryable),
    };
    return { type: 'response.failed', sequence_number: nextSequence(), response };
  };

  if (interruption !== undefined) {
    outcome.settle(interruption.verdict);
    if (interruption.verdict === 'failure') target.lastFailure = { code: interruption.code, message: interruption.message };
    opened.span.fail(interruption.spanType, interruption.error, interruption.message);
    progress.concluded = true;
    yield failedTerminal({ code: interruption.code, message: interruption.message, type: interruption.type }, orderedItems(doneItems), interruption.retryable);
    return;
  }

  const terminalEvent = upstreamTerminal as TerminalEvent;
  const upstream = terminalEvent.response;
  const upstreamOutput = upstream.output.map(rewriteItem);

  if (terminalEvent.type === 'response.failed') {
    const error = terminalEvent.response.error;
    const failureType = error.type ?? 'server_error';
    const verdict = breakerVerdictOf(failureType, error.code);
    outcome.settle(verdict);
    opened.span.fail(error.type ?? 'server_error', new Error(error.message), error.message);
    progress.concluded = true;
    yield failedTerminal({ code: error.code, message: error.message, type: failureType }, upstreamOutput, retryableFailureOf(failureType, error.code));
    return;
  }

  const reported = upstream.usage;
  const usage =
    reported ??
    estimatedUsage(
      estimateInputTokens(
        { input: resolved.forAdapter, instructions: job.body.instructions, tools: job.body.tools ?? undefined },
        opened.capabilities.imageTokens,
      ),
      estimateOutputTokens(upstreamOutput),
    );
  const usageSource: UsageSource = reported === null ? 'estimated' : 'reported';
  const status = terminalEvent.type === 'response.completed' ? 'completed' : 'incomplete';
  const resource: ResponseResource = {
    ...base,
    status,
    completed_at: completedAt,
    incomplete_details: upstream.incomplete_details,
    output: upstreamOutput,
    usage,
    momonga: momongaFor(
      usageSource,
      upstream.contextInputTokens,
      reported === null ? undefined : { usage: reported, cacheWriteInputTokens: upstream.cacheWriteInputTokens },
      undefined,
      upstream.schemaNarrowings,
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
    opened.span.fail('cancelled', cancelled, cancelled.message);
    progress.concluded = true;
    yield failedTerminal({ code: 'run_cancelled', message: cancelled.message, type: 'server_error' }, resource.output, false);
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
    ...(job.runId === undefined
      ? {}
      : {
          usage: {
            responseId,
            runId: job.runId,
            step: job.step ?? null,
            target: target.name,
            inputTokens: usage.input_tokens,
            outputTokens: usage.output_tokens,
            usageSource,
          },
        }),
  };
  let commitFailure: unknown;
  if (commit.response !== undefined || commit.idempotency !== undefined || commit.usage !== undefined) {
    try {
      services.store.commit(commit);
    } catch (error) {
      commitFailure = error;
    }
  }
  if (commitFailure !== undefined) {
    const message = `the gateway could not persist the response: ${messageOfError(commitFailure)}`;
    outcome.settle('neutral');
    opened.span.fail('server_error', commitFailure, message);
    progress.concluded = true;
    yield failedTerminal({ code: 'internal_error', message, type: 'server_error' }, resource.output, false);
    return;
  }
  job.connection?.remember(responseId, { input: resolved.stored, output: resource.output });
  outcome.settle('success');
  opened.span.succeed({
    responseModel: target.model,
    responseId,
    finishReason: finishReasonOf(resource),
    usage,
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
  const narrowed = await services.router.candidates(job.alias, {
    tools: (job.body.tools?.length ?? 0) > 0,
    images: inputHasImages(resolved.forAdapter),
    sampling: job.body,
    toolChoice: { tools: job.body.tools, tool_choice: job.body.tool_choice },
    unknownFields: { keys: Object.keys(job.unknownFields), operation: 'create' },
  });
  const disarm = armDeadline(services, job.deadlineAt, control.abort);
  try {
    const outcome = await runWithRetry({
      candidates: narrowed.targets,
      refusals: narrowed.refusals,
      policy: { ...services.config.retry, random: services.random, clock: services.clock, timers: services.timers },
      signal,
      deadlineAt: job.deadlineAt,
      attempt: (target, attemptNumber) => openAttempt(services, job, resolved, target, narrowed, attemptNumber, signal),
    });
    yield* relay(services, job, resolved, outcome, control);
  } finally {
    disarm();
  }
}
