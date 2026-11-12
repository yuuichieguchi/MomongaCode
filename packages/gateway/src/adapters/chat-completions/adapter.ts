import { sendAuthorized } from '../shared/auth.ts';
import { agentReadiness, readinessText, summaryTokenCapFor } from '@momonga/protocol';
import type { AdapterCompactRequest, AllowedToolsForm, Capabilities, ToolCallingMode, ToolChoiceWire, AdapterCompactResult, AdapterContext, AdapterRequest, AdapterTarget, LenientItems, ReasoningOrigin, RenderWireOptions, StreamEvent } from '@momonga/protocol';
import { estimatedUsage, tokensForText, wireTokensOf } from '../../core/estimate.ts';
import { NO_TOOL_CHOICE_WIRE, resolveToolChoice } from '../../core/tool-choice.ts';
import { hiddenReasoningTokens } from '../../core/hidden-reasoning.ts';
import { classifyChatCompletionsError, matchesGuardrailCode } from './classify.ts';
import { CHAT_COMPLETIONS_VOCABULARY, withGuardrailMatcher } from './vocabulary.ts';
import { upstreamSseEvents } from '../shared/body-reading.ts';
import { buildConstrainedBody } from './constrained-request.ts';
import { summaryOfTerminal, summaryRequestOf } from '../shared/compact.ts';
import { createConstrainedSink } from './constrained-sink.ts';
import type { ConstrainedPlan } from './constrained-sink.ts';
import { PreconditionFailedError, StreamFailure, UnsupportedInputError } from '../shared/failures.ts';
import { carryRefusalOfRender } from '../../core/unsupported-input.ts';
import { RENDERS_EVERY_SAMPLING_FIELD } from '../shared/sampling.ts';
import { gatewayOutputCeilingOf, watchContent, watchedPostOf } from '../shared/content-idle.ts';
import type { ContentWatch } from '../shared/content-idle.ts';
import { createEndpointPool, routeReportOf } from '../shared/http-client.ts';
import { isJsonOnlyEnforced, jsonReplyFormatOf, jsonReplyPathOf, jsonReplyPlanOf } from '../shared/json-reply.ts';
import { retryAfterHint, httpErrorOf, nestedErrorDetail } from '../shared/http-error.ts';
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
import { NO_USER_DIALECTS, resolveDialect } from '../../dialect/choice.ts';
import { RenderLedger } from '../../dialect/ledger.ts';
import { FULL_KEYWORD_SUPPORT } from '../../dialect/keyword-support.ts';
import { unavailableError } from '../../core/unavailable.ts';
import { targetProbingError } from '../../probe/auto-probe.ts';
import { idempotencyHeaderOf } from '../shared/idempotency-header.ts';

const DONE_MARKER = '[DONE]';

const NATIVE_TOOL_CHOICE: ToolChoiceWire = { forms: ['native', 'single_tool', 'filter'], expressesRequired: true };

const PINNING_CONSTRAINED_TOOL_CHOICE: ToolChoiceWire = { forms: ['envelope', 'single_tool', 'filter'], expressesRequired: true };

const LITERALLESS_CONSTRAINED_TOOL_CHOICE: ToolChoiceWire = { forms: ['filter'], expressesRequired: true };

const modeOf = ({ toolCalling }: Capabilities): ToolCallingMode => {
  if (typeof toolCalling !== 'string') {
    if (toolCalling.state === 'probing') throw targetProbingError(toolCalling);
    if (toolCalling.state === 'unavailable') throw unavailableError(toolCalling);
    throw new PreconditionFailedError(toolCalling.message, toolCalling.evidence, toolCalling.remedy);
  }
  return toolCalling;
};

export const createChatCompletionsAdapter = (options: ChatCompletionsAdapterOptions): ChatCompletionsAdapter => {
  const pool = createEndpointPool({ label: 'chat-completions', unixPath: CHAT_COMPLETIONS_PATH, urlSuffix: CHAT_COMPLETIONS_SUFFIX }, options.liveness);
  const { health, roomFacts, countTokens, isGuardrail } = options;
  const baseVocabulary = options.vocabulary ?? CHAT_COMPLETIONS_VOCABULARY;
  const guardrailMatcher = (target: AdapterTarget) => (status: number, parsed: unknown): boolean =>
    isGuardrail === undefined ? matchesGuardrailCode(parsed) : isGuardrail(target, status, parsed);
  let closing: Promise<void> | undefined;
  let closed = false;

  const toolChoiceWire = (capabilities: Capabilities, target: AdapterTarget): ToolChoiceWire => {
    const mode = modeOf(capabilities);
    if (mode === 'none') return NO_TOOL_CHOICE_WIRE;
    if (mode === 'native') return NATIVE_TOOL_CHOICE;
    const support = options.keywordSupport?.(target) ?? FULL_KEYWORD_SUPPORT;
    return support.const || support.enum ? PINNING_CONSTRAINED_TOOL_CHOICE : LITERALLESS_CONSTRAINED_TOOL_CHOICE;
  };

  const bodyFor = (
    request: AdapterRequest,
    target: AdapterTarget,
    origin: ReasoningOrigin,
    capabilities: Capabilities,
    allowedTools: readonly AllowedToolsForm[] | undefined,
  ): { body: ChatRequestBody; envelope: ConstrainedPlan | undefined; ledger: RenderLedger } => {
    const mode = modeOf(capabilities);
    const readiness = agentReadiness(capabilities);
    if (readiness.state === 'no_tools' && (request.tools ?? []).length > 0) {
      throw new UnsupportedInputError('capability_unsupported', readinessText(readiness), 'tools');
    }
    const dialect = resolveDialect(options.schemaDialect(target), options.userDialects ?? NO_USER_DIALECTS, options.constructSupport?.(target));
    if (mode === 'constrained') {
      return buildConstrainedBody(
        resolveToolChoice(request, allowedTools, target.display, toolChoiceWire(capabilities, target)),
        options.keywordSupport?.(target) ?? FULL_KEYWORD_SUPPORT,
        origin,
        dialect,
        options.envelopeShape?.(target),
      );
    }
    const ledger = new RenderLedger();
    return { body: buildNativeBody(resolveToolChoice(request, allowedTools, target.display, toolChoiceWire(capabilities, target)), origin, dialect, ledger), envelope: undefined, ledger };
  };

  const lenientWireOf = (request: AdapterRequest, target: AdapterTarget, lenient: LenientItems, origin: ReasoningOrigin, capabilities: Capabilities): ChatWire => {
    const { callNames, withTools } = lenient;
    if (modeOf(capabilities) === 'constrained') {
      return { messages: plainHistoryOf(request.input, { envelopeReplies: withTools, callNames, origin }) };
    }
    return {
      messages: withTools ? nativeHistoryOf(request.input, origin) : plainHistoryOf(request.input, { envelopeReplies: false, callNames, origin }),
    };
  };

  const renderCompactWire = (request: AdapterCompactRequest, target: AdapterTarget, cap: number, origin: ReasoningOrigin, capabilities: Capabilities): ChatWire =>
    wireOf(bodyFor(summaryRequestOf(request, cap, origin), target, origin, capabilities, undefined).body);

  const renderWire = (request: AdapterRequest, target: AdapterTarget, renderOptions: RenderWireOptions): ChatWire =>
    renderOptions.lenientItems === undefined
      ? wireOf(bodyFor(request, target, renderOptions.reasoningOrigin, renderOptions.capabilities, renderOptions.capabilities.allowedTools).body)
      : lenientWireOf(request, target, renderOptions.lenientItems, renderOptions.reasoningOrigin, renderOptions.capabilities);

  const planOf = (request: AdapterRequest, target: AdapterTarget, origin: ReasoningOrigin, capabilities: Capabilities) => {
    const planned = bodyFor(request, target, origin, capabilities, capabilities.allowedTools);
    const jsonReply = jsonReplyPlanOf(request, capabilities);
    if (jsonReply !== undefined && planned.envelope !== undefined) {
      throw new UnsupportedInputError('unsupported_input', 'a JSON reply format cannot be combined with tools on a constrained target, whose response format carries the tool envelope', 'text');
    }
    return { planned, jsonReply, responseFormat: jsonReplyFormatOf(jsonReply, resolveDialect(options.schemaDialect(target), options.userDialects ?? NO_USER_DIALECTS, options.constructSupport?.(target))) };
  };

  async function* create(request: AdapterRequest, ctx: AdapterContext): AsyncGenerator<StreamEvent> {
    if (closed) throw new Error('the chat-completions adapter is closed');
    const capabilities = ctx.capabilities;
    const { planned, jsonReply, responseFormat } = planOf(request, ctx.target, ctx.reasoningOrigin, capabilities);
    const { envelope, ledger } = planned;
    const body = {
      ...withCapabilityOptions(planned.body, request, capabilities),
      ...(responseFormat === undefined ? {} : { response_format: { type: 'json_schema', json_schema: { ...responseFormat } } }),
      ...(isJsonOnlyEnforced(jsonReply) ? { response_format: { type: 'json_object' } } : {}),
    };
    const upstream = new AbortController();
    const signal = AbortSignal.any([ctx.signal, upstream.signal]);
    let watch: ContentWatch | undefined;
    try {
      const vocabulary = withGuardrailMatcher(baseVocabulary, guardrailMatcher(ctx.target));
      const endpoint = await options.resolveEndpoint(ctx.target, signal);
      const upstreamModel = await options.upstreamModel?.(ctx.target, signal);
      const response = await sendAuthorized(options.authSource(ctx.target), signal, (bearer) =>
        pool.clientFor(endpoint).post({ ...routeReportOf(ctx),
          headers: {
            ...idempotencyHeaderOf(ctx),
            'content-type': 'application/json',
            accept: 'text/event-stream',
            ...(bearer === undefined ? {} : { authorization: `Bearer ${bearer}` }),
          },
          body: JSON.stringify(upstreamModel === undefined ? body : { ...body, model: upstreamModel }),
          signal,
          ...watchedPostOf(options.liveness),
        }),
      );
      if (response.status !== 200) {
        throw await httpErrorOf(
          response,
          options.clock,
          nestedErrorDetail,
          vocabulary,
        );
      }

      watch = watchContent(options.liveness);
      const emitter = new ResponseEmitter({ clock: options.clock, model: request.model, request, wraps: ledger.wraps, nonStrict: ledger.nonStrict, narrowings: ledger.narrowings, jsonReply: jsonReplyPathOf(jsonReply), onOutput: watch.touch, outputCeiling: gatewayOutputCeilingOf(capabilities), ...retryAfterHint(response, options.clock) });
      const sink = envelope === undefined ? createNativeSink(emitter) : createConstrainedSink(emitter, envelope, options.clock);
      const driver = new StreamDriver(emitter, sink);

      let opening: StreamEvent[] | undefined = driver.start();
      try {
        for await (const message of upstreamSseEvents(watch.source(response.body))) {
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
        estimatedUsage(wireTokensOf(renderWire(summaryRequest, ctx.target, { reasoningOrigin: ctx.reasoningOrigin, capabilities }), capabilities.imageTokens), tokensForText(collected.summary));
      return { summary: collected.summary, usage, usageSource: collected.usage === null ? ('estimated' as const) : ('reported' as const) };
    }
    throw new StreamFailure('upstream_protocol_error', 'model_error', 'the upstream ended without a terminal event');
  };

  return {
    kind: 'chat-completions',
    sampling: options.sampling ?? RENDERS_EVERY_SAMPLING_FIELD,
    relaysClientBody: [],
    capabilities: (target) => options.capabilities(target),
    create,
    compact,
    renderWire,
    renderCompactWire,
    toolChoiceWire,
    carryRefusalOf: (request, target, capabilities, origin) => carryRefusalOfRender(() => planOf(request, target, origin, capabilities)),
    classify: classifyChatCompletionsError,
    ...(health === undefined ? {} : { health: (target: AdapterTarget) => health(target) }),
    ...(roomFacts === undefined ? {} : { roomFacts: (target: AdapterTarget) => roomFacts(target) }),
    ...(countTokens === undefined
      ? {}
      : {
          countTokens: (request: Parameters<typeof countTokens>[1], ctx: AdapterContext) =>
            countTokens(ctx.target, request, ctx.signal),
        }),
    close: (stop) => {
      closed = true;
      closing ??= (async () => {
        await pool.close();
        await options.close?.(stop);
      })();
      return closing;
    },
  };
};
