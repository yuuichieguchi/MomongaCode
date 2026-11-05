import { decodeSse } from '@momonga/foundation';
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
import { hiddenReasoningTokens } from '../../core/hidden-reasoning.ts';
import { classifyChatCompletionsError, matchesGuardrailCode } from './classify.ts';
import { CHAT_COMPLETIONS_VOCABULARY, withGuardrailMatcher } from './vocabulary.ts';
import { boundedSseBytes } from '../shared/body-reading.ts';
import { buildConstrainedBody } from './constrained-request.ts';
import { summaryOfTerminal, summaryRequestOf } from '../shared/compact.ts';
import { createConstrainedSink } from './constrained-sink.ts';
import type { ConstrainedPlan } from './constrained-sink.ts';
import { StreamFailure, UnsupportedInputError } from '../shared/failures.ts';
import { createEndpointPool } from '../shared/http-client.ts';
import { httpErrorOf, nestedErrorDetail } from '../shared/http-error.ts';
import { MAX_SSE_EVENT_BYTES } from '../shared/limits.ts';
import { CHAT_COMPLETIONS_PATH, CHAT_COMPLETIONS_SUFFIX } from './limits.ts';
import { buildNativeBody } from './native-request.ts';
import type { ChatRequestBody } from './native-request.ts';
import { createNativeSink } from './native-sink.ts';
import { nativeHistoryOf, plainHistoryOf } from './plain-history.ts';
import { withCapabilityOptions } from './request-options.ts';
import { ResponseEmitter } from '../shared/response-emitter.ts';
import { StreamDriver } from './stream-driver.ts';
import { upstreamErrorEventBody, upstreamErrorFailure } from './upstream-reply.ts';
import type { ChatCompletionsAdapter, ChatCompletionsAdapterOptions } from './types.ts';
import { wireOf } from './wire.ts';
import type { ChatWire } from './wire.ts';
import { FULL_KEYWORD_SUPPORT } from '../../probe/lowering.ts';

const DONE_MARKER = '[DONE]';

export const createChatCompletionsAdapter = (options: ChatCompletionsAdapterOptions): ChatCompletionsAdapter => {
  const pool = createEndpointPool({ label: 'chat-completions', unixPath: CHAT_COMPLETIONS_PATH, urlSuffix: CHAT_COMPLETIONS_SUFFIX }, options.liveness);
  const { health, countTokens, isGuardrail } = options;
  const baseVocabulary = options.vocabulary ?? CHAT_COMPLETIONS_VOCABULARY;
  const guardrailMatcher = (target: AdapterTarget) => (status: number, parsed: unknown): boolean =>
    isGuardrail === undefined ? matchesGuardrailCode(parsed) : isGuardrail(target, status, parsed);
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
    const support = options.keywordSupport?.(target) ?? FULL_KEYWORD_SUPPORT;
    const dialect = options.schemaDialect?.(target) ?? 'json-schema-2020-12';
    if (mode === 'constrained') return buildConstrainedBody(request, support, dialect);
    return { body: buildNativeBody(request, dialect, support), envelope: undefined };
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
    const planned = bodyFor(request, ctx.target);
    const { envelope } = planned;
    const body = withCapabilityOptions(planned.body, request, await options.capabilities(ctx.target));
    const upstream = new AbortController();
    const signal = AbortSignal.any([ctx.signal, upstream.signal]);
    try {
      const vocabulary = withGuardrailMatcher(baseVocabulary, guardrailMatcher(ctx.target));
      const endpoint = await options.resolveEndpoint(ctx.target, signal);
      const apiKey = await options.apiKey?.(ctx.target, signal);
      const upstreamModel = await options.upstreamModel?.(ctx.target, signal);
      const response = await pool.clientFor(endpoint).post({
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream',
          ...(apiKey === undefined ? {} : { authorization: `Bearer ${apiKey}` }),
        },
        body: JSON.stringify(upstreamModel === undefined ? body : { ...body, model: upstreamModel }),
        signal,
      });
      if (response.status !== 200) {
        throw await httpErrorOf(
          response,
          options.clock,
          nestedErrorDetail,
          vocabulary,
        );
      }

      const emitter = new ResponseEmitter({ clock: options.clock, model: request.model, request });
      const sink = envelope === undefined ? createNativeSink(emitter) : createConstrainedSink(emitter, envelope, options.clock);
      const driver = new StreamDriver(emitter, sink);

      let opening: StreamEvent[] | undefined = driver.start();
      try {
        for await (const message of decodeSse(boundedSseBytes(response.body, MAX_SSE_EVENT_BYTES))) {
          ctx.signal.throwIfAborted();
          const errorEvent = upstreamErrorEventBody(message);
          if (errorEvent !== undefined) throw upstreamErrorFailure(vocabulary, response.status, errorEvent.body);
          if (message.data === DONE_MARKER) break;
          if (opening !== undefined) {
            const events = opening;
            opening = undefined;
            for (const event of events) yield event;
          }
          for (const event of driver.accept(message.data)) {
            ctx.signal.throwIfAborted();
            yield event;
          }
          if (driver.terminated) return;
        }
      } catch (error) {
        if (!(error instanceof StreamFailure) || opening !== undefined) throw error;
        for (const event of driver.fail(error)) {
          ctx.signal.throwIfAborted();
          yield event;
        }
        return;
      }
      if (opening !== undefined) {
        throw new StreamFailure('empty_upstream_stream', 'server_error', 'the upstream ended its stream before sending any event');
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
    const capabilities = await options.capabilities(ctx.target);
    const cap = request.momonga?.max_summary_tokens ?? summaryTokenCapFor(capabilities);
    const summaryRequest = summaryRequestOf(request, cap);
    for await (const event of create(summaryRequest, ctx)) {
      const collected = summaryOfTerminal(event, cap);
      if (collected === undefined) continue;
      if (collected.usage !== null && options.onSummaryReasoning !== undefined) {
        const hidden = hiddenReasoningTokens({
          reportedReasoningTokens: collected.usage.output_tokens_details.reasoning_tokens > 0 ? collected.usage.output_tokens_details.reasoning_tokens : undefined,
          reasoningText: undefined,
          completionTokens: collected.usage.output_tokens,
          visibleText: collected.summary,
        });
        if (hidden !== undefined && hidden > 0) await options.onSummaryReasoning(ctx.target, hidden);
      }
      const usage =
        collected.usage ??
        estimatedUsage(wireTokensOf(renderWire(summaryRequest, ctx.target), capabilities.imageTokens), tokensForText(collected.summary));
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
