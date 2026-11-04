import { isRecord } from '@momonga/foundation';
import type { OllamaProbeReport } from '@momonga/protocol';
import type { UpstreamEndpoint } from '../adapters/shared/http-client.ts';
import { isConnectionFailure } from '../adapters/shared/classify.ts';
import { StreamFailure, UpstreamHttpError } from '../adapters/shared/failures.ts';
import { ProbeTimeoutError, createProbeClient } from './client.ts';
import type { ProbeClient } from './client.ts';
import { saveEndpointRecord } from './endpoint-record.ts';
import type { EndpointKey } from './endpoint-record.ts';
import { IDENTITY_READ_TIMEOUT_MS, endpointKeyOf, probeEndpointOf } from './endpoint-target.ts';
import { parseJson } from './json.ts';

export type ProbeOllamaTargetOptions = {
  probeRecordDir: string;
  upstream: UpstreamEndpoint;
  model: string;
  contextWindow: number;
  signal?: AbortSignal;
};

export type ProbeOllamaTargetResult = { report: OllamaProbeReport; key: EndpointKey; identity: string };

const VERSION_PATH = '/api/version';
const SHOW_PATH = '/api/show';
const TAGS_PATH = '/api/tags';

const withClient = async <T>(upstream: UpstreamEndpoint, signal: AbortSignal, use: (client: ProbeClient) => Promise<T>): Promise<T> => {
  const client = createProbeClient(probeEndpointOf(upstream, undefined), signal, IDENTITY_READ_TIMEOUT_MS);
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

export const probeOllamaTarget = async (options: ProbeOllamaTargetOptions): Promise<ProbeOllamaTargetResult> => {
  const { model, upstream } = options;
  const signal = options.signal ?? new AbortController().signal;
  const { version, show, tags } = await withClient(upstream, signal, async (client) => ({
    version: await jsonOf(client, 'GET', VERSION_PATH),
    show: await jsonOf(client, 'POST', SHOW_PATH, { model }),
    tags: await jsonOf(client, 'GET', TAGS_PATH),
  }));
  const serverVersion = versionOf(version);
  if (serverVersion === undefined) throw new Error(`the server at ${endpointKeyOf(upstream)} did not answer ${VERSION_PATH} in Ollama's form`);
  const trained = trainedContextOf(show, model);
  if (options.contextWindow > trained) {
    throw new Error(`the context window ${options.contextWindow} is above the trained context length ${trained} of model ${model}`);
  }
  const identity = digestIn(tags, model);
  if (identity === undefined) throw new Error(`the Ollama server does not list model ${model}; pull it with \`ollama pull ${model}\``);
  const capabilities = capabilitiesOf(show, model);
  const report: OllamaProbeReport = {
    kind: 'ollama',
    probedAt: new Date().toISOString(),
    serverVersion,
    modelId: model,
    contextWindow: { value: trained, method: 'reported' },
    nativeTools: { accepted: capabilities.includes('tools') },
    imageInputAccepted: capabilities.includes('vision'),
    thinkingSupported: capabilities.includes('thinking'),
  };
  const key: EndpointKey = { endpoint: endpointKeyOf(upstream), model };
  await saveEndpointRecord(options.probeRecordDir, key, identity, [], report);
  return { report, key, identity };
};
