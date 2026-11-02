import { uuidv7 } from '@momonga/foundation';
import type {
  AdapterRequest,
  CreateResponseBody,
  ErrorType,
  FailedResponseResource,
  InputItem,
  ItemField,
  MomongaResponseExtension,
  ResponseError,
  ResponseResource,
  StreamEvent,
  UsageSource,
} from '@momonga/protocol';
import { TERMINAL_STREAM_EVENT_TYPES } from '@momonga/protocol';
import { startAttemptSpan } from './attempt-span.ts';
import type { AttemptSpan, TraceParent } from './attempt-span.ts';
import { applyBreakerVerdict, breakerVerdictOf } from './breaker-verdict.ts';
import type { BreakerVerdict } from './breaker-verdict.ts';
import { armDeadline } from './deadline.ts';
import { GatewayError, isRunCancelled } from './errors.ts';
import { estimateInputTokens, estimateOutputTokens, estimatedUsage } from './estimate.ts';
import { inputHasImages, resolveInput } from './input.ts';
import type { ResolvedInput } from './input.ts';
import { baseResource } from './resource.ts';
import { UpstreamFailure, emptyStreamFailure, failureFrom, runWithRetry } from './retry.ts';
import type { RetryOutcome } from './retry.ts';
import type { Release } from './admission.ts';
import type { TargetRuntime } from './router.ts';
import type { RunControl } from './run.ts';
import type { Services } from './services.ts';
import type { CommitRequest } from './store.ts';

export type ResponseJob = {
  alias: string;
  body: CreateResponseBody;
  clientInput: InputItem[];
  idempotency: { key: string; digest: string } | undefined;
  deadlineAt: number | undefined;
  parent: TraceParent | undefined;
  runId: string | undefined;
  step: number | undefined;
};

type Opened = {
  iterator: AsyncIterator<StreamEvent>;
  first: StreamEvent;
  release: Release;
  span: AttemptSpan;
};

type Pulled = { kind: 'event'; event: StreamEvent } | { kind: 'failed'; error: unknown };

type Interruption = {
  code: string;
  message: string;
  type: ErrorType;
  spanType: string;
  error: unknown;
  verdict: BreakerVerdict;
};

const OPENING_EVENT_TYPES: ReadonlySet<string> = new Set(['response.created', 'response.queued', 'response.in_progress']);
const TERMINAL_TYPES: ReadonlySet<string> = new Set(TERMINAL_STREAM_EVENT_TYPES);

type TerminalEvent = Extract<StreamEvent, { response: ResponseResource }>;

const adapterRequestFor = (job: ResponseJob, resolved: ResolvedInput, target: TargetRuntime): AdapterRequest => {
  const { body } = job;
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
  };
};

const errorTypeOf = (failure: unknown): string => {
  if (failure instanceof UpstreamFailure) return failure.classified.error.type;
  if (failure instanceof GatewayError) return failure.body.type;
  return 'cancelled';
};

const messageOf = (failure: unknown): string => (failure instanceof Error ? failure.message : String(failure));

const openAttempt = async (
  services: Services,
  job: ResponseJob,
  resolved: ResolvedInput,
  target: TargetRuntime,
  attemptNumber: number,
  signal: AbortSignal,
): Promise<Opened> => {
  const release = await target.gate.acquire(signal);
  const span = startAttemptSpan({
    telemetry: services.telemetry,
    parent: job.parent,
    providerName: target.provider,
    requestModel: target.model,
    maxTokens: job.body.max_output_tokens ?? undefined,
    stream: job.body.stream === true,
    runId: job.runId,
    step: job.step,
    attempt: attemptNumber,
  });
  try {
    const stream = target.adapter.create(adapterRequestFor(job, resolved, target), {
      signal,
      target: { name: target.name, model: target.model },
      attempt: attemptNumber,
    });
    const iterator = stream[Symbol.asyncIterator]();
    const first = await iterator.next();
    if (first.done === true) throw emptyStreamFailure();
    return { iterator, first: first.value, release, span };
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
    };
  }
  return {
    code: 'client_disconnected',
    message: 'the client disconnected before the response completed',
    type: 'server_error',
    spanType: 'cancelled',
    error: failure,
    verdict: 'neutral',
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
});

const finishReasonOf = (resource: ResponseResource): string =>
  resource.status === 'completed' ? 'stop' : (resource.incomplete_details?.reason ?? resource.status);

const orderedItems = (items: Map<number, ItemField>): ItemField[] =>
  [...items.entries()].sort(([left], [right]) => left - right).map(([, item]) => item);

const messageOfError = (error: unknown): string => (error instanceof Error ? error.message : String(error));

async function* relay(
  services: Services,
  job: ResponseJob,
  resolved: ResolvedInput,
  outcome: RetryOutcome<Opened>,
  control: RunControl,
): AsyncGenerator<StreamEvent> {
  const { signal } = control;
  const { value: opened, target, attempts, fallbackFrom } = outcome;
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
    let event: StreamEvent = opened.first;
    for (;;) {
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
      const pulled = await pull();
      if (pulled.kind === 'event') {
        event = pulled.event;
        continue;
      }
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
            };
      break;
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

  const momongaFor = (usageSource: UsageSource): MomongaResponseExtension => ({
    alias: job.alias,
    target: target.name,
    attempts,
    ...(fallbackFrom.length === 0 ? {} : { fallbackFrom }),
    usageSource,
  });
  const completedAt = Math.floor(clock.now() / 1000);

  const failedTerminal = (error: ResponseError, output: ItemField[]): StreamEvent => {
    const response: FailedResponseResource = {
      ...base,
      status: 'failed',
      completed_at: completedAt,
      output,
      error,
      momonga: momongaFor('estimated'),
    };
    return { type: 'response.failed', sequence_number: nextSequence(), response };
  };

  if (interruption !== undefined) {
    applyBreakerVerdict(target.breaker, interruption.verdict);
    opened.span.fail(interruption.spanType, interruption.error, interruption.message);
    yield failedTerminal({ code: interruption.code, message: interruption.message, type: interruption.type }, orderedItems(doneItems));
    return;
  }

  const terminalEvent = upstreamTerminal as TerminalEvent;
  const upstream = terminalEvent.response;
  const upstreamOutput = upstream.output.map(rewriteItem);

  if (terminalEvent.type === 'response.failed') {
    const error = terminalEvent.response.error;
    applyBreakerVerdict(target.breaker, breakerVerdictOf(error.type ?? 'server_error', error.code));
    opened.span.fail(error.type ?? 'server_error', new Error(error.message), error.message);
    yield failedTerminal({ ...error, type: error.type ?? 'server_error' }, upstreamOutput);
    return;
  }

  const reported = upstream.usage;
  const usage =
    reported ??
    estimatedUsage(
      estimateInputTokens({ input: resolved.forAdapter, instructions: job.body.instructions, tools: job.body.tools ?? undefined }),
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
    momonga: momongaFor(usageSource),
  };
  const terminal: StreamEvent = {
    type: terminalEvent.type,
    sequence_number: nextSequence(),
    response: resource,
  };

  if (isRunCancelled(signal.reason)) {
    const cancelled = signal.reason as GatewayError;
    opened.span.fail('cancelled', cancelled, cancelled.message);
    yield failedTerminal({ code: 'run_cancelled', message: cancelled.message, type: 'server_error' }, resource.output);
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
    opened.span.fail('server_error', commitFailure, message);
    yield failedTerminal({ code: 'internal_error', message, type: 'server_error' }, resource.output);
    return;
  }
  target.breaker.onSuccess();
  opened.span.succeed({ responseModel: target.model, responseId, finishReason: finishReasonOf(resource), usage });
  yield terminal;
}

export async function* executeResponse(services: Services, job: ResponseJob, control: RunControl): AsyncGenerator<StreamEvent> {
  const { signal } = control;
  const resolved = resolveInput(services.store, services.codec, job.body.previous_response_id, job.clientInput);
  const candidates = await services.router.candidates(job.alias, { tools: (job.body.tools?.length ?? 0) > 0, images: inputHasImages(resolved.forAdapter) });
  const disarm = armDeadline(services, job.deadlineAt, control.abort);
  try {
    const outcome = await runWithRetry({
      candidates,
      policy: { ...services.config.retry, random: services.random, clock: services.clock, timers: services.timers },
      signal,
      deadlineAt: job.deadlineAt,
      attempt: (target, attemptNumber) => openAttempt(services, job, resolved, target, attemptNumber, signal),
    });
    yield* relay(services, job, resolved, outcome, control);
  } finally {
    disarm();
  }
}
