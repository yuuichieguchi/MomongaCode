import { decodeSse } from '@momonga/foundation';
import { EXACT_ERROR_SHAPE, countReplyOf, summaryTokenCapFor } from '@momonga/protocol';
import type { AdapterCompactRequest, AdapterCompactResult, AdapterContext, AdapterCountTokensResult, AdapterInputItem, AdapterRequest, AdapterTarget, CountTokensRequest, ReasoningOrigin, StreamEvent } from '@momonga/protocol';
import { estimatedUsage, tokensForText, wireTokensOf } from '../../core/estimate.ts';
import { normalizeInput } from '../../core/input.ts';
import { resolveToolChoice } from '../shared/tool-choice.ts';
import type { ToolChoiceWire } from '../shared/tool-choice.ts';
import { boundedSseBytes, readTextLimited } from '../shared/body-reading.ts';
import { createUpstreamClassifier } from '../shared/classify.ts';
import { summaryOfTerminal, summaryRequestOf } from '../shared/compact.ts';
import { StreamFailure, UnsupportedInputError, UpstreamProtocolError } from '../shared/failures.ts';
import { parseUpstreamJson } from '../shared/upstream-json.ts';
import { createEndpointPool } from '../shared/http-client.ts';
import type { CompletionResponse } from '../shared/http-client.ts';
import { retryAfterHint, httpErrorOf } from '../shared/http-error.ts';
import { HTTP_TRANSPORT_VOCABULARY } from '../shared/vocabulary.ts';
import { MAX_SSE_EVENT_BYTES, MAX_UNARY_BODY_BYTES } from '../shared/limits.ts';
import { ResponseEmitter } from '../shared/response-emitter.ts';
import {
  ANTHROPIC_COUNT_TOKENS_SUBPATH,
  ANTHROPIC_MESSAGES_PATH,
  ANTHROPIC_PROVIDER_LABEL,
  ANTHROPIC_VERSION,
  MAX_PAUSE_CONTINUATIONS,
} from './constants.ts';
import { anthropicErrorDetail } from './errors.ts';
import { parseAnthropicEvent } from './events.ts';
import type { AnthropicUsageFields } from './events.ts';
import { assertCountable, buildCountTokensBody, buildMessagesBody } from './request.ts';
import type { AnthropicCountTokensBody, CachePlan } from './request.ts';
import type { AnthropicRequestBody } from './request.ts';
import { AnthropicStreamDriver, inputTokensOf } from './stream-driver.ts';
import type { AnthropicAdapter, AnthropicAdapterOptions } from './types.ts';

type Paused = { content: Record<string, unknown>[]; usage: AnthropicUsageFields; firstInputTokens: number };

const countTokensOf = (text: string): number => {
  const parsed = parseUpstreamJson(text, (what) => new UpstreamProtocolError(`the upstream count_tokens reply is malformed: ${what}`));
  const tokens = typeof parsed === 'object' && parsed !== null ? (parsed as { input_tokens?: unknown }).input_tokens : undefined;
  if (typeof tokens !== 'number' || !Number.isSafeInteger(tokens) || tokens < 0) {
    throw new UpstreamProtocolError('the upstream count_tokens reply lacks a non-negative integer input_tokens');
  }
  return tokens;
};

const asAdapterInput = (request: CountTokensRequest): AdapterInputItem[] =>
  normalizeInput(request.input).map((item) => {
    if (item.type === 'compaction') throw new UnsupportedInputError('unsupported_input', 'a compaction item must be decoded before token counting', 'input');
    return item;
  });

const ANTHROPIC_TOOL_CHOICE: ToolChoiceWire = { forms: ['single_tool', 'filter'], expressesRequired: true };

export const createAnthropicAdapter = (options: AnthropicAdapterOptions): AnthropicAdapter => {
  const pool = createEndpointPool({ label: ANTHROPIC_PROVIDER_LABEL, unixPath: ANTHROPIC_MESSAGES_PATH, urlSuffix: ANTHROPIC_MESSAGES_PATH }, options.liveness);
  const { health } = options;
  let closing: Promise<void> | undefined;
  let closed = false;

  const headersFor = (apiKey: string, accept: string): Record<string, string> => ({
    'content-type': 'application/json',
    accept,
    'x-api-key': apiKey,
    'anthropic-version': ANTHROPIC_VERSION,
  });

  async function* readSegment(response: CompletionResponse, driver: AnthropicStreamDriver, ctx: AdapterContext): AsyncGenerator<StreamEvent> {
    try {
      for await (const message of decodeSse(boundedSseBytes(response.body, MAX_SSE_EVENT_BYTES))) {
        ctx.signal.throwIfAborted();
        for (const event of driver.accept(parseAnthropicEvent(message.data))) {
          ctx.signal.throwIfAborted();
          yield event;
        }
        if (driver.concluded) return;
      }
      for (const event of driver.end()) {
        ctx.signal.throwIfAborted();
        yield event;
      }
    } catch (error) {
      if (!(error instanceof UpstreamProtocolError) || !driver.hasStarted) throw error;
      for (const event of driver.fail(error)) {
        ctx.signal.throwIfAborted();
        yield event;
      }
    }
  }

  async function* stream(request: AdapterRequest, ctx: AdapterContext, cache: CachePlan | undefined): AsyncGenerator<StreamEvent> {
    if (closed) throw new Error('the anthropic adapter is closed');
    const capabilities = await options.capabilities(ctx.target);
    const base = buildMessagesBody(resolveToolChoice(request, capabilities.allowedTools, ctx.target.name, ANTHROPIC_TOOL_CHOICE), capabilities.maxOutputTokens, { cache, reasoning: capabilities.reasoning }, ctx.reasoningOrigin);
    const upstream = new AbortController();
    const signal = AbortSignal.any([ctx.signal, upstream.signal]);
    try {
      const endpoint = await options.resolveEndpoint(ctx.target);
      const apiKey = await options.apiKey(ctx.target, signal);
      let emitter: ResponseEmitter | undefined;
      let paused: Paused | undefined;
      for (let continuation = 0; ; continuation += 1) {
        const body: AnthropicRequestBody =
          paused === undefined ? base : { ...base, messages: [...base.messages, { role: 'assistant', content: paused.content }] };
        const response = await pool.clientFor(endpoint).post({ headers: headersFor(apiKey, 'text/event-stream'), body: JSON.stringify(body), signal });
        if (response.status !== 200) throw await httpErrorOf(response, options.clock, anthropicErrorDetail, HTTP_TRANSPORT_VOCABULARY);
        emitter ??= new ResponseEmitter({ clock: options.clock, model: request.model, request, ...retryAfterHint(response, options.clock) });
        const driver = new AnthropicStreamDriver(emitter, paused === undefined ? undefined : { usage: paused.usage, firstInputTokens: paused.firstInputTokens });
        yield* readSegment(response, driver, ctx);
        if (!driver.paused) return;
        if (continuation >= MAX_PAUSE_CONTINUATIONS) {
          for (const event of driver.fail({
            code: 'pause_turn_limit_exceeded',
            errorType: 'model_error',
            message: `the upstream paused the turn more than ${MAX_PAUSE_CONTINUATIONS} times in a row`,
          })) {
            ctx.signal.throwIfAborted();
            yield event;
          }
          return;
        }
        paused = {
          content: [...(paused?.content ?? []), ...driver.pausedContent()],
          usage: driver.accumulatedUsage(),
          firstInputTokens: paused?.firstInputTokens ?? inputTokensOf(driver.accumulatedUsage()),
        };
      }
    } finally {
      upstream.abort();
    }
  }

  async function* create(request: AdapterRequest, ctx: AdapterContext): AsyncGenerator<StreamEvent> {
    const { promptCache } = await options.capabilities(ctx.target);
    const cache: CachePlan | undefined =
      promptCache?.kind === 'breakpoints'
        ? { maxBreakpoints: promptCache.maxBreakpoints, ...(request.cacheMarks === undefined ? {} : { marks: request.cacheMarks }) }
        : undefined;
    yield* stream(request, ctx, cache);
  }

  const postCount = async (body: AnthropicCountTokensBody, ctx: AdapterContext): Promise<AdapterCountTokensResult> => {
    if (closed) throw new Error('the anthropic adapter is closed');
    assertCountable(body);
    const upstream = new AbortController();
    const signal = AbortSignal.any([ctx.signal, upstream.signal]);
    try {
      const endpoint = await options.resolveEndpoint(ctx.target);
      const apiKey = await options.apiKey(ctx.target, signal);
      const response = await pool.clientFor(endpoint).post({
        headers: headersFor(apiKey, 'application/json'),
        body: JSON.stringify(body),
        signal,
        subpath: ANTHROPIC_COUNT_TOKENS_SUBPATH,
      });
      if (response.status !== 200) throw await httpErrorOf(response, options.clock, anthropicErrorDetail, HTTP_TRANSPORT_VOCABULARY);
      const { text, truncated } = await readTextLimited(response.body, MAX_UNARY_BODY_BYTES);
      if (truncated) throw new UpstreamProtocolError(`the upstream count_tokens reply exceeds ${MAX_UNARY_BODY_BYTES} bytes`);
      return countReplyOf(countTokensOf(text), 'exact', EXACT_ERROR_SHAPE);
    } finally {
      upstream.abort();
    }
  };

  const countTokens = async (request: CountTokensRequest, ctx: AdapterContext): Promise<AdapterCountTokensResult> => {
    const { allowedTools } = await options.capabilities(ctx.target);
    return postCount(
      buildCountTokensBody(
        resolveToolChoice(
          {
            model: request.model,
            input: asAdapterInput(request),
            ...(request.instructions === undefined ? {} : { instructions: request.instructions }),
            ...(request.tools === undefined ? {} : { tools: request.tools }),
            ...(request.tool_choice === undefined ? {} : { tool_choice: request.tool_choice }),
          },
          allowedTools,
          ctx.target.name,
          ANTHROPIC_TOOL_CHOICE,
        ),
        ctx.reasoningOrigin,
      ),
      ctx,
    );
  };

  const countWire = (wire: Record<string, unknown>, ctx: AdapterContext): Promise<AdapterCountTokensResult> => {
    const { system, messages, tools, tool_choice: toolChoice } = wire as Omit<AnthropicCountTokensBody, 'model'>;
    return postCount(
      {
        model: ctx.target.model,
        ...(system === undefined ? {} : { system }),
        messages,
        ...(tools === undefined ? {} : { tools }),
        ...(toolChoice === undefined ? {} : { tool_choice: toolChoice }),
      },
      ctx,
    );
  };

  const compact = async (request: AdapterCompactRequest, ctx: AdapterContext): Promise<AdapterCompactResult> => {
    const capabilities = await options.capabilities(ctx.target);
    const cap = request.momonga?.max_summary_tokens ?? summaryTokenCapFor(capabilities);
    const summaryRequest = summaryRequestOf(request, cap, ctx.reasoningOrigin);
    for await (const event of stream(summaryRequest, ctx, undefined)) {
      const collected = summaryOfTerminal(event, cap);
      if (collected === undefined) continue;
      const usage =
        collected.usage ??
        estimatedUsage(
          wireTokensOf(buildMessagesBody(summaryRequest, cap, { cache: undefined, reasoning: capabilities.reasoning }, ctx.reasoningOrigin), capabilities.imageTokens),
          tokensForText(collected.summary),
        );
      return { summary: collected.summary, usage, ...(collected.cacheWriteInputTokens === undefined ? {} : { cacheWriteInputTokens: collected.cacheWriteInputTokens }) };
    }
    throw new StreamFailure('upstream_protocol_error', 'model_error', 'the upstream ended without a terminal event');
  };

  const renderCompactWire = (request: AdapterCompactRequest, _target: AdapterTarget, cap: number, origin: ReasoningOrigin): Record<string, unknown> => {
    const { model: _model, stream: _stream, max_tokens: _maxTokens, ...wire } = buildMessagesBody(summaryRequestOf(request, cap, origin), cap, { cache: undefined }, origin);
    return wire;
  };

  return {
    kind: ANTHROPIC_PROVIDER_LABEL,
    capabilities: (target) => options.capabilities(target),
    create,
    countTokens,
    countWire,
    compact,
    renderCompactWire,
    classify: createUpstreamClassifier(ANTHROPIC_PROVIDER_LABEL),
    ...(health === undefined ? {} : { health: (target: AdapterTarget) => health(target) }),
    close: () => {
      closed = true;
      closing ??= pool.close();
      return closing;
    },
  };
};
