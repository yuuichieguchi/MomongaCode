import { decodeSse } from '@momonga/foundation';
import { agentReadiness, readinessText, summaryTokenCapFor } from '@momonga/protocol';
import type { Capabilities, ToolChoiceWire, AdapterCompactRequest, AdapterCompactResult, AdapterContext, AdapterRequest, AdapterTarget, ReasoningOrigin, StreamEvent } from '@momonga/protocol';
import { resolveToolChoice } from '../../core/tool-choice.ts';
import { estimatedUsage, tokensForText, wireTokensOf } from '../../core/estimate.ts';
import { boundedSseBytes } from '../shared/body-reading.ts';
import { createUpstreamClassifier } from '../shared/classify.ts';
import { summaryOfTerminal, summaryRequestOf } from '../shared/compact.ts';
import { StreamFailure, UnsupportedInputError, UpstreamProtocolError } from '../shared/failures.ts';
import { gatewayOutputCeilingOf, watchContent, watchedPostOf } from '../shared/content-idle.ts';
import type { ContentWatch } from '../shared/content-idle.ts';
import { createEndpointPool } from '../shared/http-client.ts';
import { jsonReplyPathOf, jsonReplyPlanOf } from '../shared/json-reply.ts';
import { CHAT_COMPLETIONS_VOCABULARY } from '../chat-completions/vocabulary.ts';
import { retryAfterHint, httpErrorOf, nestedErrorDetail } from '../shared/http-error.ts';
import { MAX_SSE_EVENT_BYTES } from '../shared/limits.ts';
import { RenderLedger } from '../../dialect/ledger.ts';
import { ResponseEmitter } from '../shared/response-emitter.ts';
import { RENDERS_EVERY_SAMPLING_FIELD } from '../shared/sampling.ts';
import { OPEN_RESPONSES_PATH, OPEN_RESPONSES_PROVIDER_LABEL, OPEN_RESPONSES_SUFFIX, SSE_DONE_MARKER } from './constants.ts';
import { parseOpenResponsesEvent } from './events.ts';
import { buildResponsesBody, carriesResponsesOutputBound } from './request.ts';
import { OpenResponsesStreamDriver } from './stream-driver.ts';
import type { OpenResponsesAdapter, OpenResponsesAdapterOptions } from './types.ts';

const OPEN_RESPONSES_TOOL_CHOICE: ToolChoiceWire = { forms: ['native', 'single_tool', 'filter'], expressesRequired: true };

export const createOpenResponsesAdapter = (options: OpenResponsesAdapterOptions): OpenResponsesAdapter => {
  const pool = createEndpointPool({ label: OPEN_RESPONSES_PROVIDER_LABEL, unixPath: OPEN_RESPONSES_PATH, urlSuffix: OPEN_RESPONSES_SUFFIX }, options.liveness);
  const { health } = options;
  let closing: Promise<void> | undefined;
  let closed = false;

  async function* create(request: AdapterRequest, ctx: AdapterContext): AsyncGenerator<StreamEvent> {
    if (closed) throw new Error('the open-responses adapter is closed');
    const capabilities = ctx.capabilities;
    const readiness = agentReadiness(capabilities);
    if (readiness.state === 'no_tools' && (request.tools ?? []).length > 0) {
      throw new UnsupportedInputError('capability_unsupported', readinessText(readiness), 'tools');
    }
    const ledger = new RenderLedger();
    const jsonReply = jsonReplyPlanOf(request, capabilities);
    const body = {
      ...buildResponsesBody(resolveToolChoice(request, capabilities.allowedTools, ctx.target.name, OPEN_RESPONSES_TOOL_CHOICE), ctx.reasoningOrigin, {
        schemaDialect: capabilities.schemaDialect,
        ledger,
        jsonReply,
        carriesOutputBound: carriesResponsesOutputBound(capabilities),
        ...(options.userDialects === undefined ? {} : { userDialects: options.userDialects }),
      }),
      ...(capabilities.promptCache?.kind === 'key' && request.promptCacheKey !== undefined ? { prompt_cache_key: request.promptCacheKey } : {}),
    };
    const upstream = new AbortController();
    const signal = AbortSignal.any([ctx.signal, upstream.signal]);
    let watch: ContentWatch | undefined;
    try {
      const endpoint = await options.resolveEndpoint(ctx.target);
      const apiKey = await options.apiKey?.(ctx.target, signal);
      const response = await pool.clientFor(endpoint).post({
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream',
          ...(apiKey === undefined ? {} : { authorization: `Bearer ${apiKey}` }),
        },
        body: JSON.stringify(body),
        signal,
        ...watchedPostOf(options.liveness),
      });
      if (response.status !== 200) throw await httpErrorOf(response, options.clock, nestedErrorDetail, CHAT_COMPLETIONS_VOCABULARY);

      watch = watchContent(options.liveness);
      const emitter = new ResponseEmitter({ clock: options.clock, model: request.model, request, wraps: ledger.wraps, narrowings: ledger.narrowings, jsonReply: jsonReplyPathOf(jsonReply), onOutput: watch.touch, outputCeiling: gatewayOutputCeilingOf(capabilities), ...retryAfterHint(response, options.clock) });
      const driver = new OpenResponsesStreamDriver(emitter);
      try {
        for await (const message of decodeSse(boundedSseBytes(watch.source(response.body), MAX_SSE_EVENT_BYTES))) {
          ctx.signal.throwIfAborted();
          if (message.data === SSE_DONE_MARKER) break;
          for (const event of driver.accept(parseOpenResponsesEvent(message.data))) {
            ctx.signal.throwIfAborted();
            yield event;
          }
          if (driver.terminated) return;
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
    } finally {
      watch?.dispose();
      upstream.abort();
    }
  }

  const compact = async (request: AdapterCompactRequest, ctx: AdapterContext): Promise<AdapterCompactResult> => {
    const capabilities = ctx.capabilities;
    const cap = request.momonga?.max_summary_tokens ?? summaryTokenCapFor(capabilities);
    const summaryRequest = summaryRequestOf(request, cap, ctx.reasoningOrigin);
    for await (const event of create(summaryRequest, ctx)) {
      const collected = summaryOfTerminal(event, cap);
      if (collected === undefined) continue;
      const usage = collected.usage ?? estimatedUsage(wireTokensOf(buildResponsesBody(summaryRequest, ctx.reasoningOrigin), capabilities.imageTokens), tokensForText(collected.summary));
      return { summary: collected.summary, usage };
    }
    throw new StreamFailure('upstream_protocol_error', 'model_error', 'the upstream ended without a terminal event');
  };

  const renderCompactWire = (request: AdapterCompactRequest, _target: AdapterTarget, cap: number, origin: ReasoningOrigin, capabilities: Capabilities): Record<string, unknown> => {
    const { model: _model, stream: _stream, store: _store, ...wire } = buildResponsesBody(summaryRequestOf(request, cap, origin), origin, { carriesOutputBound: carriesResponsesOutputBound(capabilities) });
    return wire;
  };

  return {
    kind: OPEN_RESPONSES_PROVIDER_LABEL,
    sampling: RENDERS_EVERY_SAMPLING_FIELD,
    relaysClientBody: ['create'],
    capabilities: (target) => options.capabilities(target),
    create,
    compact,
    renderCompactWire,
    toolChoiceWire: () => OPEN_RESPONSES_TOOL_CHOICE,
    classify: createUpstreamClassifier(OPEN_RESPONSES_PROVIDER_LABEL),
    ...(health === undefined ? {} : { health: (target: AdapterTarget) => health(target) }),
    close: () => {
      closed = true;
      closing ??= pool.close();
      return closing;
    },
  };
};
