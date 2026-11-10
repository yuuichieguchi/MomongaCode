import { decodeSse } from '@momonga/foundation';
import { EXACT_ERROR_SHAPE, anthropicVersionSamplingBound, countReplyOf, summaryTokenCapFor } from '@momonga/protocol';
import type { ToolChoiceWire, AdapterCompactRequest, AdapterSampling, AdapterCompactResult, AdapterContext, AdapterCountTokensResult, AdapterInputItem, AdapterRequest, AdapterTarget, CountTokensRequest, ReasoningOrigin, StreamEvent } from '@momonga/protocol';
import { estimatedUsage, tokensForText, wireTokensOf } from '../../core/estimate.ts';
import { normalizeInput } from '../../core/input.ts';
import { resolveToolChoice } from '../../core/tool-choice.ts';
import { boundedSseBytes, readTextLimited } from '../shared/body-reading.ts';
import { sendAuthorized } from '../shared/auth.ts';
import { createUpstreamClassifier } from '../shared/classify.ts';
import { summaryOfTerminal, summaryRequestOf } from '../shared/compact.ts';
import { StreamFailure, UnsupportedInputError, UpstreamProtocolError } from '../shared/failures.ts';
import { parseUpstreamJson } from '../shared/upstream-json.ts';
import { gatewayOutputCeilingOf, watchContent, watchedPostOf } from '../shared/content-idle.ts';
import type { ContentWatch } from '../shared/content-idle.ts';
import { createEndpointPool } from '../shared/http-client.ts';
import { jsonReplyPathOf, jsonReplyPlanOf } from '../shared/json-reply.ts';
import type { CompletionResponse } from '../shared/http-client.ts';
import { retryAfterHint, httpErrorOf } from '../shared/http-error.ts';
import { HTTP_TRANSPORT_VOCABULARY } from '../shared/vocabulary.ts';
import { MAX_SSE_EVENT_BYTES, MAX_UNARY_BODY_BYTES } from '../shared/limits.ts';
import { NO_USER_DIALECTS, resolveDialect } from '../../dialect/choice.ts';
import { RenderLedger } from '../../dialect/ledger.ts';
import { ResponseEmitter } from '../shared/response-emitter.ts';
import {
  ANTHROPIC_COUNT_TOKENS_SUBPATH,
  ANTHROPIC_MESSAGES_PATH,
  ANTHROPIC_PROVIDER_LABEL,
  ANTHROPIC_SAMPLING_FIELDS,
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
import { idempotencyHeaderOf } from '../shared/idempotency-header.ts';

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
  const apiVersion = options.apiVersion;
  const sampling: AdapterSampling = {
    renders: ANTHROPIC_SAMPLING_FIELDS,
    bound: { label: `API version ${apiVersion}`, accepts: anthropicVersionSamplingBound(apiVersion) },
  };
  let closing: Promise<void> | undefined;
  let closed = false;

  const headersFor = (key: string | undefined, accept: string): Record<string, string> => ({
    'content-type': 'application/json',
    accept,
    ...(key === undefined ? {} : { 'x-api-key': key }),
    'anthropic-version': apiVersion,
  });

  async function* readSegment(response: CompletionResponse, watch: ContentWatch, driver: AnthropicStreamDriver, ctx: AdapterContext): AsyncGenerator<StreamEvent> {
    try {
      for await (const message of decodeSse(boundedSseBytes(watch.source(response.body), MAX_SSE_EVENT_BYTES))) {
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
    const capabilities = ctx.capabilities;
    const ledger = new RenderLedger();
    const dialect = resolveDialect(capabilities.schemaDialect, options.userDialects ?? NO_USER_DIALECTS);
    const jsonReply = jsonReplyPlanOf(request, capabilities);
    const base = buildMessagesBody(resolveToolChoice(request, capabilities.allowedTools, ctx.target.display, ANTHROPIC_TOOL_CHOICE), capabilities.maxOutputTokens, { cache, reasoning: capabilities.reasoning, dialect, ledger, jsonReply }, ctx.reasoningOrigin);
    const upstream = new AbortController();
    const signal = AbortSignal.any([ctx.signal, upstream.signal]);
    let watch: ContentWatch | undefined;
    try {
      const endpoint = await options.resolveEndpoint(ctx.target, signal);
      const auth = options.authSource(ctx.target);
      let emitter: ResponseEmitter | undefined;
      let paused: Paused | undefined;
      const outputCeiling = gatewayOutputCeilingOf(capabilities);
      for (let continuation = 0; ; continuation += 1) {
        const body: AnthropicRequestBody =
          paused === undefined ? base : { ...base, messages: [...base.messages, { role: 'assistant', content: paused.content }] };
        const response = await sendAuthorized(auth, signal, (key) =>
          pool.clientFor(endpoint).post({ headers: { ...idempotencyHeaderOf(ctx, continuation), ...headersFor(key, 'text/event-stream') }, body: JSON.stringify(body), signal, ...watchedPostOf(options.liveness) }),
        );
        if (response.status !== 200) throw await httpErrorOf(response, options.clock, anthropicErrorDetail, HTTP_TRANSPORT_VOCABULARY);
        watch?.dispose();
        const segmentWatch = watchContent(options.liveness);
        watch = segmentWatch;
        emitter ??= new ResponseEmitter({ clock: options.clock, model: request.model, request, wraps: ledger.wraps, narrowings: ledger.narrowings, jsonReply: jsonReplyPathOf(jsonReply), onOutput: () => watch?.touch(), outputCeiling, ...retryAfterHint(response, options.clock) });
        const driver = new AnthropicStreamDriver(emitter, paused === undefined ? undefined : { usage: paused.usage, firstInputTokens: paused.firstInputTokens });
        yield* readSegment(response, segmentWatch, driver, ctx);
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
      watch?.dispose();
      upstream.abort();
    }
  }

  async function* create(request: AdapterRequest, ctx: AdapterContext): AsyncGenerator<StreamEvent> {
    const { promptCache } = ctx.capabilities;
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
      const endpoint = await options.resolveEndpoint(ctx.target, signal);
      const response = await sendAuthorized(options.authSource(ctx.target), signal, (key) =>
        pool.clientFor(endpoint).post({
          headers: headersFor(key, 'application/json'),
          body: JSON.stringify(body),
          signal,
          subpath: ANTHROPIC_COUNT_TOKENS_SUBPATH,
        }),
      );
      if (response.status !== 200) throw await httpErrorOf(response, options.clock, anthropicErrorDetail, HTTP_TRANSPORT_VOCABULARY);
      const { text, truncated } = await readTextLimited(response.body, MAX_UNARY_BODY_BYTES);
      if (truncated) throw new UpstreamProtocolError(`the upstream count_tokens reply exceeds ${MAX_UNARY_BODY_BYTES} bytes`);
      return countReplyOf(countTokensOf(text), 'exact', EXACT_ERROR_SHAPE);
    } finally {
      upstream.abort();
    }
  };

  const countTokens = async (request: CountTokensRequest, ctx: AdapterContext): Promise<AdapterCountTokensResult> => {
    const { allowedTools } = ctx.capabilities;
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
          ctx.target.display,
          ANTHROPIC_TOOL_CHOICE,
        ),
        ctx.reasoningOrigin,
        resolveDialect(ctx.capabilities.schemaDialect, options.userDialects ?? NO_USER_DIALECTS),
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
    const capabilities = ctx.capabilities;
    const cap = request.momonga?.max_summary_tokens ?? summaryTokenCapFor(capabilities);
    const summaryRequest = summaryRequestOf(request, cap, ctx.reasoningOrigin);
    for await (const event of stream(summaryRequest, ctx, undefined)) {
      const collected = summaryOfTerminal(event, cap);
      if (collected === undefined) continue;
      const usage =
        collected.usage ??
        estimatedUsage(
          wireTokensOf(buildMessagesBody(summaryRequest, cap, { cache: undefined, reasoning: capabilities.reasoning, dialect: resolveDialect(capabilities.schemaDialect, options.userDialects ?? NO_USER_DIALECTS) }, ctx.reasoningOrigin), capabilities.imageTokens),
          tokensForText(collected.summary),
        );
      return { summary: collected.summary, usage, usageSource: collected.usage === null ? ('estimated' as const) : ('reported' as const), ...(collected.cacheWriteInputTokens === undefined ? {} : { cacheWriteInputTokens: collected.cacheWriteInputTokens }) };
    }
    throw new StreamFailure('upstream_protocol_error', 'model_error', 'the upstream ended without a terminal event');
  };

  const renderCompactWire = (request: AdapterCompactRequest, _target: AdapterTarget, cap: number, origin: ReasoningOrigin): Record<string, unknown> => {
    const { model: _model, stream: _stream, max_tokens: _maxTokens, ...wire } = buildMessagesBody(summaryRequestOf(request, cap, origin), cap, { cache: undefined }, origin);
    return wire;
  };

  return {
    kind: ANTHROPIC_PROVIDER_LABEL,
    sampling,
    relaysClientBody: [],
    capabilities: (target) => options.capabilities(target),
    create,
    countTokens,
    countWire,
    compact,
    renderCompactWire,
    toolChoiceWire: () => ANTHROPIC_TOOL_CHOICE,
    classify: createUpstreamClassifier(ANTHROPIC_PROVIDER_LABEL),
    ...(health === undefined ? {} : { health: (target: AdapterTarget) => health(target) }),
    close: () => {
      closed = true;
      closing ??= pool.close();
      return closing;
    },
  };
};
