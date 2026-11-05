import { summaryTokenCapFor } from '@momonga/protocol';
import type { AdapterCompactRequest, AdapterCompactResult, AdapterContext, AdapterRequest, AdapterTarget, StreamEvent } from '@momonga/protocol';
import { createUpstreamClassifier } from '../shared/classify.ts';
import { summaryOfTerminal, summaryRequestOf } from '../shared/compact.ts';
import { StreamFailure, UpstreamProtocolError } from '../shared/failures.ts';
import { createEndpointPool } from '../shared/http-client.ts';
import { httpErrorOf } from '../shared/http-error.ts';
import type { ErrorDetailReader } from '../shared/http-error.ts';
import { buildOllamaBody } from './request.ts';
import { ollamaEventsOf } from './stream.ts';
import type { OllamaAdapter, OllamaAdapterOptions } from './types.ts';
import { OLLAMA_VOCABULARY, ollamaErrorText } from './vocabulary.ts';

const OLLAMA_LABEL = 'ollama';
const OLLAMA_CHAT_PATH = '/api/chat';
const MODEL_NOT_FOUND = /^model\b.*\bnot found\b/i;

const detailReader =
  (model: string): ErrorDetailReader =>
  (parsed) => {
    const text = ollamaErrorText(parsed);
    if (text === undefined) return {};
    return { message: MODEL_NOT_FOUND.test(text) ? `${text}; pull it with \`ollama pull ${model}\`` : text };
  };

export const createOllamaAdapter = (options: OllamaAdapterOptions): OllamaAdapter => {
  const pool = createEndpointPool({ label: OLLAMA_LABEL, unixPath: OLLAMA_CHAT_PATH, urlSuffix: OLLAMA_CHAT_PATH }, options.liveness);
  const { health } = options;
  let closing: Promise<void> | undefined;
  let closed = false;

  async function* create(request: AdapterRequest, ctx: AdapterContext): AsyncGenerator<StreamEvent> {
    if (closed) throw new Error('the ollama adapter is closed');
    const body = buildOllamaBody(request, await options.capabilities(ctx.target), ctx.reasoningOrigin);
    const upstream = new AbortController();
    const signal = AbortSignal.any([ctx.signal, upstream.signal]);
    try {
      const endpoint = await options.resolveEndpoint(ctx.target, signal);
      const response = await pool.clientFor(endpoint).post({
        headers: { 'content-type': 'application/json', accept: 'application/x-ndjson' },
        body: JSON.stringify(body),
        signal,
      });
      if (response.status !== 200) throw await httpErrorOf(response, options.clock, detailReader(request.model), OLLAMA_VOCABULARY);
      for await (const event of ollamaEventsOf(response.body, { request, clock: options.clock })) {
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
    for await (const event of create(summaryRequestOf(request, cap, ctx.reasoningOrigin), ctx)) {
      const collected = summaryOfTerminal(event, cap);
      if (collected === undefined) continue;
      if (collected.usage === null) throw new UpstreamProtocolError('the upstream reported no usage for the summary');
      return { summary: collected.summary, usage: collected.usage };
    }
    throw new StreamFailure('upstream_protocol_error', 'model_error', 'the upstream ended without a terminal event');
  };

  return {
    kind: OLLAMA_LABEL,
    capabilities: (target: AdapterTarget) => options.capabilities(target),
    create,
    compact,
    classify: createUpstreamClassifier(OLLAMA_LABEL),
    ...(health === undefined ? {} : { health: (target: AdapterTarget) => health(target) }),
    close: () => {
      closed = true;
      closing ??= pool.close();
      return closing;
    },
  };
};
