import { decodeSse } from '@momonga/foundation';
import { summaryTokenCapFor } from '@momonga/protocol';
import type {
  AdapterCompactRequest,
  AdapterCompactResult,
  AdapterContext,
  AdapterRequest,
  AdapterTarget,
  StreamEvent,
} from '@momonga/protocol';
import { estimatedUsage, tokensForText, wireTokensOf } from '../../core/estimate.ts';
import { boundedSseBytes } from '../shared/body-reading.ts';
import { createUpstreamClassifier } from '../shared/classify.ts';
import { summaryOfTerminal, summaryRequestOf } from '../shared/compact.ts';
import { StreamFailure, UpstreamProtocolError } from '../shared/failures.ts';
import { createEndpointPool } from '../shared/http-client.ts';
import { httpErrorOf } from '../shared/http-error.ts';
import { MAX_SSE_EVENT_BYTES } from '../shared/limits.ts';
import { ResponseEmitter } from '../shared/response-emitter.ts';
import { ANTHROPIC_MESSAGES_PATH, ANTHROPIC_PROVIDER_LABEL, ANTHROPIC_VERSION } from './constants.ts';
import { anthropicErrorDetail } from './errors.ts';
import { parseAnthropicEvent } from './events.ts';
import { buildMessagesBody } from './request.ts';
import { AnthropicStreamDriver } from './stream-driver.ts';
import type { AnthropicAdapter, AnthropicAdapterOptions } from './types.ts';

const neverGuardrail = (): boolean => false;

export const createAnthropicAdapter = (options: AnthropicAdapterOptions): AnthropicAdapter => {
  const pool = createEndpointPool({ label: ANTHROPIC_PROVIDER_LABEL, unixPath: ANTHROPIC_MESSAGES_PATH, urlSuffix: ANTHROPIC_MESSAGES_PATH });
  const { health } = options;
  let closing: Promise<void> | undefined;
  let closed = false;

  const maxTokensOf = async (target: AdapterTarget): Promise<number> => (await options.capabilities(target)).maxOutputTokens;

  async function* create(request: AdapterRequest, ctx: AdapterContext): AsyncGenerator<StreamEvent> {
    if (closed) throw new Error('the anthropic adapter is closed');
    const body = buildMessagesBody(request, await maxTokensOf(ctx.target));
    const upstream = new AbortController();
    const signal = AbortSignal.any([ctx.signal, upstream.signal]);
    try {
      const endpoint = await options.resolveEndpoint(ctx.target);
      const apiKey = await options.apiKey(ctx.target, signal);
      const response = await pool.clientFor(endpoint).post({
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream',
          'x-api-key': apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
        },
        body: JSON.stringify(body),
        signal,
      });
      if (response.status !== 200) throw await httpErrorOf(response, options.clock, anthropicErrorDetail, neverGuardrail);

      const emitter = new ResponseEmitter({ clock: options.clock, model: request.model, request });
      const driver = new AnthropicStreamDriver(emitter);
      try {
        for await (const message of decodeSse(boundedSseBytes(response.body, MAX_SSE_EVENT_BYTES))) {
          ctx.signal.throwIfAborted();
          for (const event of driver.accept(parseAnthropicEvent(message.data))) {
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
        estimatedUsage(wireTokensOf(buildMessagesBody(summaryRequest, cap)), tokensForText(collected.summary));
      return { summary: collected.summary, usage };
    }
    throw new StreamFailure('upstream_protocol_error', 'model_error', 'the upstream ended without a terminal event');
  };

  const renderCompactWire = (request: AdapterCompactRequest, target: AdapterTarget, cap: number): Record<string, unknown> => {
    const { model: _model, stream: _stream, max_tokens: _maxTokens, ...wire } = buildMessagesBody(summaryRequestOf(request, cap), cap);
    return wire;
  };

  return {
    kind: ANTHROPIC_PROVIDER_LABEL,
    capabilities: (target) => options.capabilities(target),
    create,
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
