import { agentReadiness, isUnavailableCapabilities, readinessText, summaryTokenCapFor } from '@momonga/protocol';
import type { ClassifiedError, ResponseError, Capabilities, ToolChoiceWire, AdapterCompactRequest, AdapterCompactResult, AdapterContext, AdapterRequest, AdapterTarget, ReasoningOrigin, StreamEvent } from '@momonga/protocol';
import { unavailableError } from '../../core/unavailable.ts';
import { carryRefusalOfRender } from '../../core/unsupported-input.ts';
import { resolveToolChoice } from '../../core/tool-choice.ts';
import { estimatedUsage, tokensForText, wireTokensOf } from '../../core/estimate.ts';
import { upstreamSseEvents } from '../shared/body-reading.ts';
import { afterCredentialEffect, sendAuthorized } from '../shared/auth.ts';
import { createUpstreamClassifier } from '../shared/classify.ts';
import { summaryOfTerminal, summaryRequestOf } from '../shared/compact.ts';
import { StreamFailure, UnsupportedInputError, UpstreamProtocolError } from '../shared/failures.ts';
import { gatewayOutputCeilingOf, watchContent, watchedPostOf } from '../shared/content-idle.ts';
import type { ContentWatch } from '../shared/content-idle.ts';
import { createEndpointPool, routeReportOf } from '../shared/http-client.ts';
import { jsonReplyPathOf, jsonReplyPlanOf } from '../shared/json-reply.ts';
import { CHAT_COMPLETIONS_VOCABULARY } from '../chat-completions/vocabulary.ts';
import { retryAfterHint, httpErrorOf, nestedErrorDetail } from '../shared/http-error.ts';
import { RenderLedger } from '../../dialect/ledger.ts';
import { ResponseEmitter } from '../shared/response-emitter.ts';
import { RENDERS_EVERY_SAMPLING_FIELD } from '../shared/sampling.ts';
import { OPEN_RESPONSES_PATH, OPEN_RESPONSES_PROVIDER_LABEL, OPEN_RESPONSES_SUFFIX, SSE_DONE_MARKER } from './constants.ts';
import { parseOpenResponsesEvent } from './events.ts';
import { buildResponsesBody, carriesResponsesOutputBound } from './request.ts';
import { OpenResponsesStreamDriver } from './stream-driver.ts';
import type { OpenResponsesAdapter, OpenResponsesAdapterOptions } from './types.ts';
import { idempotencyHeaderOf } from '../shared/idempotency-header.ts';

const OPEN_RESPONSES_TOOL_CHOICE: ToolChoiceWire = { forms: ['native', 'single_tool', 'filter'], expressesRequired: true };

export const createOpenResponsesAdapter = (options: OpenResponsesAdapterOptions): OpenResponsesAdapter => {
  const pool = createEndpointPool({ label: OPEN_RESPONSES_PROVIDER_LABEL, unixPath: OPEN_RESPONSES_PATH, urlSuffix: OPEN_RESPONSES_SUFFIX }, options.liveness);
  const { health } = options;
  let closing: Promise<void> | undefined;
  let closed = false;

  const classify = createUpstreamClassifier(OPEN_RESPONSES_PROVIDER_LABEL, options.errorRules);

  const failedEventError = (error: ResponseError): StreamFailure => new StreamFailure(error.code, error.type ?? 'server_error', error.message);

  const classifyFailedEvent = (error: ResponseError): ClassifiedError => {
    const classified = classify(failedEventError(error));
    return error.retryAfterMs === undefined ? classified : { ...classified, retryAfterMs: error.retryAfterMs };
  };

  const planOf = (request: AdapterRequest, target: AdapterTarget, capabilities: Capabilities, origin: ReasoningOrigin) => {
    const readiness = agentReadiness(capabilities);
    if (readiness.state === 'no_tools' && (request.tools ?? []).length > 0) {
      throw new UnsupportedInputError('capability_unsupported', readinessText(readiness), 'tools');
    }
    const ledger = new RenderLedger();
    const jsonReply = jsonReplyPlanOf(request, capabilities);
    const body = {
      ...buildResponsesBody(resolveToolChoice(request, capabilities.allowedTools, target.display, OPEN_RESPONSES_TOOL_CHOICE), origin, {
        schemaDialect: capabilities.schemaDialect,
        ledger,
        jsonReply,
        carriesOutputBound: carriesResponsesOutputBound(capabilities),
        output: capabilities,
        ...(capabilities.systemRole === undefined ? {} : { systemRole: capabilities.systemRole }),
        ...(capabilities.toolPlacement === undefined ? {} : { toolPlacement: capabilities.toolPlacement }),
        ...(options.userDialects === undefined ? {} : { userDialects: options.userDialects }),
      }),
      ...(capabilities.promptCache?.kind === 'key' && request.promptCacheKey !== undefined ? { prompt_cache_key: request.promptCacheKey } : {}),
    };
    return { ledger, jsonReply, body };
  };

  async function* create(request: AdapterRequest, ctx: AdapterContext): AsyncGenerator<StreamEvent> {
    if (closed) throw new Error('the open-responses adapter is closed');
    const capabilities = ctx.capabilities;
    if (isUnavailableCapabilities(capabilities)) throw unavailableError(capabilities.toolCalling);
    const { ledger, jsonReply, body } = planOf(request, ctx.target, capabilities, ctx.reasoningOrigin);
    const upstream = new AbortController();
    const signal = AbortSignal.any([ctx.signal, upstream.signal]);
    let watch: ContentWatch | undefined;
    try {
      const endpoint = await options.resolveEndpoint(ctx.target, signal);
      const auth = options.authSource(ctx.target);
      const response = await sendAuthorized(auth, signal, (bearer) =>
        pool.clientFor(endpoint).post({ ...routeReportOf(ctx),
          headers: {
            ...idempotencyHeaderOf(ctx),
            'content-type': 'application/json',
            accept: 'text/event-stream',
            ...(bearer === undefined ? {} : { authorization: `Bearer ${bearer}` }),
          },
          body: JSON.stringify(body),
          signal,
          ...watchedPostOf(options.liveness),
        }),
      );
      if (response.status !== 200) {
        const failure = await httpErrorOf(response, options.clock, nestedErrorDetail, CHAT_COMPLETIONS_VOCABULARY);
        throw await afterCredentialEffect(failure, auth, classify(failure), options.clock, ctx.signal);
      }

      watch = watchContent(options.liveness);
      const emitter = new ResponseEmitter({ clock: options.clock, model: request.model, request, wraps: ledger.wraps, narrowings: ledger.narrowings, jsonReply: jsonReplyPathOf(jsonReply), onOutput: watch.touch, outputCeiling: gatewayOutputCeilingOf(capabilities), ...retryAfterHint(response, options.clock) });
      const driver = new OpenResponsesStreamDriver(emitter);
      try {
        for await (const message of upstreamSseEvents(watch.source(response.body))) {
          ctx.signal.throwIfAborted();
          if (message.data === SSE_DONE_MARKER) break;
          for (const event of driver.accept(parseOpenResponsesEvent(message.data))) {
            ctx.signal.throwIfAborted();
            if (event.type === 'response.failed') {
              const failure = await afterCredentialEffect(failedEventError(event.response.error), auth, classifyFailedEvent(event.response.error), options.clock, ctx.signal);
              if (failure.cause !== undefined) throw failure;
            }
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
      const usage = collected.usage ?? estimatedUsage(wireTokensOf(buildResponsesBody(summaryRequest, ctx.reasoningOrigin, { carriesOutputBound: carriesResponsesOutputBound(capabilities), output: capabilities }), capabilities.imageTokens), tokensForText(collected.summary));
      return { summary: collected.summary, usage, usageSource: collected.usage === null ? ('estimated' as const) : ('reported' as const) };
    }
    throw new StreamFailure('upstream_protocol_error', 'model_error', 'the upstream ended without a terminal event');
  };

  const renderCompactWire = (request: AdapterCompactRequest, _target: AdapterTarget, cap: number, origin: ReasoningOrigin, capabilities: Capabilities): Record<string, unknown> => {
    const { model: _model, stream: _stream, store: _store, ...wire } = buildResponsesBody(summaryRequestOf(request, cap, origin), origin, { carriesOutputBound: carriesResponsesOutputBound(capabilities), output: capabilities });
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
    carryRefusalOf: (request, target, capabilities, origin) => carryRefusalOfRender(() => planOf(request, target, capabilities, origin)),
    classify,
    servedAccount: (target: AdapterTarget) => options.authSource(target).resolvedAccount(),
    ...(health === undefined ? {} : { health: (target: AdapterTarget) => health(target) }),
    close: () => {
      closed = true;
      closing ??= pool.close();
      return closing;
    },
  };
};
