import { decodeSse, parseRetryAfter } from '@momonga/foundation';
import type { Clock } from '@momonga/foundation';
import { summaryTokenCapFor } from '@momonga/protocol';
import type {
  AdapterCompactRequest,
  AdapterCompactResult,
  AdapterContext,
  AdapterRequest,
  AdapterTarget,
  LenientItems,
  RenderWireOptions,
  StreamEvent,
} from '@momonga/protocol';
import { estimatedUsage, tokensForText, wireTokensOf } from '../../core/estimate.ts';
import { classifyChatCompletionsError, matchesGuardrailCode } from './classify.ts';
import { boundedSseBytes, readTextLimited } from './body-reading.ts';
import { buildConstrainedBody } from './constrained-request.ts';
import { summaryOfTerminal, summaryRequestOf } from './compact.ts';
import { createConstrainedSink } from './constrained-sink.ts';
import type { ConstrainedPlan } from './constrained-sink.ts';
import { StreamFailure, UnsupportedInputError, UpstreamHttpError } from './failures.ts';
import { createEndpointPool } from './http-client.ts';
import type { CompletionResponse } from './http-client.ts';
import { MAX_ERROR_BODY_BYTES, MAX_SSE_EVENT_BYTES } from './limits.ts';
import { buildNativeBody } from './native-request.ts';
import type { ChatRequestBody } from './native-request.ts';
import { createNativeSink } from './native-sink.ts';
import { nativeHistoryOf, plainHistoryOf } from './plain-history.ts';
import { ResponseEmitter } from './response-emitter.ts';
import { StreamDriver } from './stream-driver.ts';
import type { ChatCompletionsAdapter, ChatCompletionsAdapterOptions } from './types.ts';
import { wireOf } from './wire.ts';
import type { ChatWire } from './wire.ts';
import type { KeywordSupport } from '../../probe/envelope.ts';

const FULL_KEYWORD_SUPPORT: KeywordSupport = {
  enum: true,
  anyOf: true,
  const: true,
  pattern: true,
  minimum: true,
  nested: true,
  additionalProperties: true,
};

const DONE_MARKER = '[DONE]';
const MAX_UPSTREAM_MESSAGE_CHARS = 500;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const httpErrorOf = async (
  response: CompletionResponse,
  clock: Clock,
  isGuardrail: (status: number, body: unknown) => boolean,
): Promise<UpstreamHttpError> => {
  const text = await readTextLimited(response.body, MAX_ERROR_BODY_BYTES);
  let message = text.slice(0, MAX_UPSTREAM_MESSAGE_CHARS);
  let code: string | null = null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
    const detail = isRecord(parsed) ? parsed['error'] : undefined;
    if (isRecord(detail)) {
      if (typeof detail['message'] === 'string') message = detail['message'];
      if (typeof detail['code'] === 'string') code = detail['code'];
    }
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
  }
  const retryAfterMs = parseRetryAfter(response.headers['retry-after'], clock.now());
  return new UpstreamHttpError(
    response.status,
    code,
    message === '' ? `HTTP ${response.status}` : message,
    retryAfterMs,
    isGuardrail(response.status, parsed),
  );
};

export const createChatCompletionsAdapter = (options: ChatCompletionsAdapterOptions): ChatCompletionsAdapter => {
  const pool = createEndpointPool();
  const { health, countTokens, isGuardrail } = options;
  let closing: Promise<void> | undefined;
  let closed = false;

  const bodyFor = (
    request: AdapterRequest,
    target: AdapterTarget,
  ): { body: ChatRequestBody; envelope: ConstrainedPlan | undefined } => {
    const mode = options.toolCalling(target);
    const hasTools = (request.tools ?? []).length > 0;
    if (mode === 'none' && hasTools) {
      throw new UnsupportedInputError('capability_unsupported', 'this target does not support tool calling', 'tools');
    }
    if (mode === 'constrained') {
      return buildConstrainedBody(request, options.keywordSupport?.(target) ?? FULL_KEYWORD_SUPPORT);
    }
    return { body: buildNativeBody(request), envelope: undefined };
  };

  const lenientWireOf = (request: AdapterRequest, target: AdapterTarget, lenient: LenientItems): ChatWire => {
    const { callNames, withTools } = lenient;
    if (options.toolCalling(target) === 'constrained') {
      return { messages: plainHistoryOf(request.input, { envelopeReplies: withTools, callNames }) };
    }
    return {
      messages: withTools ? nativeHistoryOf(request.input) : plainHistoryOf(request.input, { envelopeReplies: false, callNames }),
    };
  };

  const renderCompactWire = (request: AdapterCompactRequest, target: AdapterTarget, cap: number): ChatWire =>
    wireOf(bodyFor(summaryRequestOf(request, cap), target).body);

  const renderWire = (request: AdapterRequest, target: AdapterTarget, renderOptions?: RenderWireOptions): ChatWire =>
    renderOptions?.lenientItems === undefined
      ? wireOf(bodyFor(request, target).body)
      : lenientWireOf(request, target, renderOptions.lenientItems);

  async function* create(request: AdapterRequest, ctx: AdapterContext): AsyncGenerator<StreamEvent> {
    if (closed) throw new Error('the chat-completions adapter is closed');
    const { body, envelope } = bodyFor(request, ctx.target);
    const upstream = new AbortController();
    const signal = AbortSignal.any([ctx.signal, upstream.signal]);
    try {
      const endpoint = await options.resolveEndpoint(ctx.target);
      const apiKey = await options.apiKey?.(ctx.target);
      const response = await pool.clientFor(endpoint).post({
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream',
          ...(apiKey === undefined ? {} : { authorization: `Bearer ${apiKey}` }),
        },
        body: JSON.stringify(body),
        signal,
      });
      if (response.status !== 200) {
        throw await httpErrorOf(response, options.clock, (status, parsed) =>
          isGuardrail === undefined ? matchesGuardrailCode(parsed) : isGuardrail(ctx.target, status, parsed),
        );
      }

      const emitter = new ResponseEmitter({ clock: options.clock, model: request.model, request });
      const sink = envelope === undefined ? createNativeSink(emitter) : createConstrainedSink(emitter, envelope, options.clock);
      const driver = new StreamDriver(emitter, sink);

      for (const event of driver.start()) {
        ctx.signal.throwIfAborted();
        yield event;
      }
      try {
        for await (const message of decodeSse(boundedSseBytes(response.body, MAX_SSE_EVENT_BYTES))) {
          ctx.signal.throwIfAborted();
          if (message.data === DONE_MARKER) break;
          for (const event of driver.accept(message.data)) {
            ctx.signal.throwIfAborted();
            yield event;
          }
          if (driver.terminated) return;
        }
      } catch (error) {
        if (!(error instanceof StreamFailure)) throw error;
        for (const event of driver.fail(error)) {
          ctx.signal.throwIfAborted();
          yield event;
        }
        return;
      }
      for (const event of driver.end()) {
        ctx.signal.throwIfAborted();
        yield event;
      }
    } finally {
      upstream.abort();
    }
  }

  const compact = async (request: AdapterCompactRequest, ctx: AdapterContext): Promise<AdapterCompactResult> => {
    const cap = request.momonga?.max_summary_tokens ?? summaryTokenCapFor(await options.capabilities(ctx.target));
    const summaryRequest = summaryRequestOf(request, cap);
    for await (const event of create(summaryRequest, ctx)) {
      const collected = summaryOfTerminal(event, cap);
      if (collected === undefined) continue;
      const usage =
        collected.usage ??
        estimatedUsage(wireTokensOf(renderWire(summaryRequest, ctx.target)), tokensForText(collected.summary));
      return { summary: collected.summary, usage };
    }
    throw new StreamFailure('upstream_protocol_error', 'model_error', 'the upstream ended without a terminal event');
  };

  return {
    kind: 'chat-completions',
    capabilities: (target) => options.capabilities(target),
    create,
    compact,
    renderWire,
    renderCompactWire,
    classify: classifyChatCompletionsError,
    ...(health === undefined ? {} : { health: (target: AdapterTarget) => health(target) }),
    ...(countTokens === undefined
      ? {}
      : {
          countTokens: (request: Parameters<typeof countTokens>[1], ctx: AdapterContext) =>
            countTokens(ctx.target, request, ctx.signal),
        }),
    close: () => {
      closed = true;
      closing ??= (async () => {
        await pool.close();
        await options.close?.();
      })();
      return closing;
    },
  };
};
