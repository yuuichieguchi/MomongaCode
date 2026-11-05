import { isRecord } from '@momonga/foundation';
import type { OllamaProbeReport } from '@momonga/protocol';
import type { UpstreamEndpoint } from '../adapters/shared/http-client.ts';
import { buildOllamaChatBody } from '../adapters/ollama/request.ts';
import { NO_REASONING_IS_OWN } from '../adapters/shared/reasoning-origin.ts';
import { isConnectionFailure } from '../adapters/shared/classify.ts';
import { StreamFailure, UpstreamHttpError } from '../adapters/shared/failures.ts';
import { ProbeTimeoutError, createProbeClient } from './client.ts';
import type { HttpResult, ProbeClient } from './client.ts';
import { saveEndpointRecord } from './endpoint-record.ts';
import type { EndpointKey } from './endpoint-record.ts';
import { IDENTITY_READ_TIMEOUT_MS, probeEndpointOf } from './endpoint-target.ts';
import { cachedCountOf } from './cached-count.ts';
import { IMAGE_PROMPT, measureImageTokens } from './image-tokens.ts';
import type { ImageCostProbe } from './image-tokens.ts';
import { parseJson } from './json.ts';

export type ProbeOllamaTargetOptions = {
  probeRecordDir: string;
  upstream: UpstreamEndpoint;
  key: EndpointKey;
  model: string;
  contextWindow: number;
  signal?: AbortSignal;
};

export type ProbeOllamaTargetResult = { report: OllamaProbeReport; key: EndpointKey; identity: string };

const CHAT_PATH = '/api/chat';
const CACHE_PROBE_WORDS = 1536;
const CACHE_PROBE_OUTPUT_TOKENS = 1;
const CACHE_PROBE_TIMEOUT_MS = 120_000;
const VERSION_PATH = '/api/version';
const SHOW_PATH = '/api/show';
const TAGS_PATH = '/api/tags';

const withClient = async <T>(
  upstream: UpstreamEndpoint,
  signal: AbortSignal,
  use: (client: ProbeClient) => Promise<T>,
  timeoutMs: number = IDENTITY_READ_TIMEOUT_MS,
): Promise<T> => {
  const client = createProbeClient(probeEndpointOf(upstream, undefined), signal, timeoutMs);
  try {
    return await use(client);
  } catch (error) {
    if (error instanceof ProbeTimeoutError) {
      throw new StreamFailure('provider_unavailable', 'server_error', `the Ollama server did not answer within ${error.timeoutMs} ms`);
    }
    throw error;
  } finally {
    await client.close();
  }
};

const jsonOf = async (client: ProbeClient, method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> => {
  const result = await client.request(method, path, body);
  if (result.status !== 200) throw new UpstreamHttpError(result.status, null, `${method} ${path} was refused: ${result.text}`, undefined, false);
  return parseJson(result.text);
};

const versionOf = (body: unknown): string | undefined => {
  const version = isRecord(body) ? body['version'] : undefined;
  return typeof version === 'string' ? version : undefined;
};

export const answersAsOllama = async (upstream: UpstreamEndpoint, signal: AbortSignal): Promise<boolean> => {
  try {
    return await withClient(upstream, signal, async (client) => {
      const result = await client.request('GET', VERSION_PATH);
      return result.status === 200 && versionOf(parseJson(result.text)) !== undefined;
    });
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof StreamFailure || isConnectionFailure(error)) return false;
    throw error;
  }
};

const tagMatches = (listed: string, model: string): boolean => listed === model || (!model.includes(':') && listed === `${model}:latest`);

const digestIn = (tags: unknown, model: string): string | undefined => {
  const models = isRecord(tags) ? tags['models'] : undefined;
  if (!Array.isArray(models)) throw new Error('the Ollama server answered /api/tags without a models list');
  const entry: unknown = models.find((candidate) => isRecord(candidate) && typeof candidate['name'] === 'string' && tagMatches(candidate['name'], model));
  if (!isRecord(entry)) return undefined;
  const digest = entry['digest'];
  if (typeof digest !== 'string' || digest === '') throw new Error(`the Ollama server lists model ${model} without a digest`);
  return digest;
};

export const readOllamaDigest = (upstream: UpstreamEndpoint, model: string, signal: AbortSignal): Promise<string | undefined> =>
  withClient(upstream, signal, async (client) => digestIn(await jsonOf(client, 'GET', TAGS_PATH), model));

const trainedContextOf = (show: unknown, model: string): number => {
  const info = isRecord(show) ? show['model_info'] : undefined;
  if (!isRecord(info)) throw new Error(`/api/show for model ${model} carries no model_info`);
  const architecture = info['general.architecture'];
  if (typeof architecture !== 'string') throw new Error(`/api/show for model ${model} carries no general.architecture`);
  const length = info[`${architecture}.context_length`];
  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 1) {
    throw new Error(`/api/show for model ${model} carries no ${architecture}.context_length`);
  }
  return length;
};

const capabilitiesOf = (show: unknown, model: string): readonly string[] => {
  const capabilities = isRecord(show) ? show['capabilities'] : undefined;
  if (!Array.isArray(capabilities) || !capabilities.every((entry): entry is string => typeof entry === 'string')) {
    throw new Error(`/api/show for model ${model} carries no capabilities list`);
  }
  return capabilities;
};

const promptEvalCountOf = (body: unknown): number | undefined => {
  const count = isRecord(body) ? body['prompt_eval_count'] : undefined;
  return typeof count === 'number' && Number.isSafeInteger(count) && count >= 0 ? count : undefined;
};

const imageCostProbeOf = (client: ProbeClient, model: string, contextWindow: number): ImageCostProbe => {
  const send = (imageUrl: string | undefined): Promise<HttpResult> => {
    const request = buildOllamaChatBody(
      {
        model,
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: IMAGE_PROMPT }, ...(imageUrl === undefined ? [] : [{ type: 'input_image' as const, image_url: imageUrl }])],
          },
        ],
      },
      { contextWindow, maxOutputTokens: CACHE_PROBE_OUTPUT_TOKENS },
      false,
      NO_REASONING_IS_OWN,
    );
    return client.request('POST', CHAT_PATH, request);
  };
  return {
    baseline: async () => {
      const result = await send(undefined);
      if (result.status !== 200) throw new UpstreamHttpError(result.status, null, `POST ${CHAT_PATH} was refused for the image token baseline: ${result.text}`, undefined, false);
      return promptEvalCountOf(parseJson(result.text));
    },
    cost: async (imageUrl) => {
      const result = await send(imageUrl);
      if (result.status === 400) return { rejected: true };
      if (result.status !== 200) throw new UpstreamHttpError(result.status, null, `POST ${CHAT_PATH} was refused for an image token measurement: ${result.text}`, undefined, false);
      return { rejected: false, promptTokens: promptEvalCountOf(parseJson(result.text)) };
    },
  };
};

const measurePromptCache = async (client: ProbeClient, model: string, contextWindow: number): Promise<OllamaProbeReport['promptCache']> => {
  const request = buildOllamaChatBody(
    { model, input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: Array.from({ length: CACHE_PROBE_WORDS }, () => 'word').join(' ') }] }] },
    { contextWindow, maxOutputTokens: CACHE_PROBE_OUTPUT_TOKENS },
    false,
    NO_REASONING_IS_OWN,
  );
  await jsonOf(client, 'POST', CHAT_PATH, request);
  const repeated = await jsonOf(client, 'POST', CHAT_PATH, request);
  const cached = cachedCountOf(isRecord(repeated) ? repeated['prompt_eval_cached_count'] : undefined, 'prompt_eval_cached_count');
  if (cached === undefined) return undefined;
  return { kind: cached > 0 ? 'automatic' : 'none' };
};

export const probeOllamaTarget = async (options: ProbeOllamaTargetOptions): Promise<ProbeOllamaTargetResult> => {
  const { model, upstream } = options;
  const signal = options.signal ?? new AbortController().signal;
  const { version, show, tags } = await withClient(upstream, signal, async (client) => ({
    version: await jsonOf(client, 'GET', VERSION_PATH),
    show: await jsonOf(client, 'POST', SHOW_PATH, { model }),
    tags: await jsonOf(client, 'GET', TAGS_PATH),
  }));
  const serverVersion = versionOf(version);
  if (serverVersion === undefined) throw new Error(`the server at ${options.key.endpoint} did not answer ${VERSION_PATH} in Ollama's form`);
  const trained = trainedContextOf(show, model);
  if (options.contextWindow > trained) {
    throw new Error(`the context window ${options.contextWindow} is above the trained context length ${trained} of model ${model}`);
  }
  const identity = digestIn(tags, model);
  if (identity === undefined) throw new Error(`the Ollama server does not list model ${model}; pull it with \`ollama pull ${model}\``);
  const capabilities = capabilitiesOf(show, model);
  const imageInputAccepted = capabilities.includes('vision');
  const imageTokens = imageInputAccepted
    ? await withClient(upstream, signal, (client) => measureImageTokens(imageCostProbeOf(client, model, options.contextWindow)), CACHE_PROBE_TIMEOUT_MS)
    : undefined;
  const promptCache = await withClient(upstream, signal, (client) => measurePromptCache(client, model, options.contextWindow), CACHE_PROBE_TIMEOUT_MS);
  const report: OllamaProbeReport = {
    kind: 'ollama',
    probedAt: new Date().toISOString(),
    serverVersion,
    modelId: model,
    contextWindow: { value: trained, method: 'reported' },
    nativeTools: { accepted: capabilities.includes('tools') },
    imageInputAccepted,
    ...(imageTokens === undefined ? {} : { imageTokens }),
    thinkingSupported: capabilities.includes('thinking'),
    ...(promptCache === undefined ? {} : { promptCache }),
  };
  const { key } = options;
  await saveEndpointRecord(options.probeRecordDir, key, identity, [], report);
  return { report, key, identity };
};
