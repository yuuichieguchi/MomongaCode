import { isRecord } from '@momonga/foundation';
import { SERVER_KINDS } from '@momonga/protocol';
import { readModelDetails } from '../detect-local-servers.ts';
import { field } from './reply.ts';
import type { DialectId, OllamaProbeReport } from '@momonga/protocol';
import { NO_USER_DIALECTS } from '../dialect/choice.ts';
import type { UserDialects } from '../dialect/choice.ts';
import type { UpstreamEndpoint } from '../adapters/shared/http-client.ts';
import { buildOllamaChatBody } from '../adapters/ollama/request.ts';
import { NO_REASONING_IS_OWN } from '../adapters/shared/reasoning-origin.ts';
import { StreamFailure, UpstreamHttpError } from '../adapters/shared/failures.ts';
import { ProbeTimeoutError, createProbeClient } from './client.ts';
import type { ProbePorts } from './client.ts';
import type { HttpResult, ProbeClient } from './client.ts';
import { saveEndpointRecord } from './endpoint-record.ts';
import type { EndpointKey } from './endpoint-record.ts';
import { IDENTITY_READ_TIMEOUT_MS, probeEndpointOf } from './endpoint-target.ts';
import { cachedCountOf } from './cached-count.ts';
import { maxOutputTokensFor } from './decide.ts';
import { CACHE_PROBE_WORDS, DEFAULT_SAMPLES, DEFAULT_STEP_TIMEOUT_MS, PROBE_METHOD_VERSION } from './run-probe.ts';
import { messagesOf, selectDialect } from './select-dialect.ts';
import type { SelectionTransport } from './select-dialect.ts';
import { IMAGE_PROMPT, measureImageTokens } from './image-tokens.ts';
import type { ImageCostProbe } from './image-tokens.ts';
import { parseExternalJson } from '../adapters/shared/json.ts';
import { usableUpstreamJson } from '../adapters/shared/upstream-json.ts';
import { JSON_MODE_PROBE_REQUEST, measureJsonMode } from './json-mode.ts';
import type { JsonModeAnswer } from './json-mode.ts';
import { jsonReplyPlanOf } from '../adapters/shared/json-reply.ts';
import { OLLAMA_VOCABULARY } from '../adapters/ollama/vocabulary.ts';
import { recordProbe } from './auto-probe.ts';
import type { MeasureProbe, ProbePrecondition, ProbeSubject } from './auto-probe.ts';
import { endpointKeyOfLock, endpointLockKeyOf } from './endpoint-record.ts';
import type { EndpointLockKey } from './endpoint-record.ts';
import type { DialectCurrency } from '../dialect/candidates.ts';
import type { KernelLockMechanism } from '@momonga/foundation';

export type ProbeOllamaTargetOptions = {
  ports: ProbePorts;
  stepTimeoutMs?: number;
  probeRecordDir: string;
  lock: KernelLockMechanism;
  upstream: UpstreamEndpoint;
  key: EndpointKey;
  model: string;
  contextWindow: number;
  samples?: number;
  userDialects?: UserDialects;
  declaredDialect?: DialectId;
  signal?: AbortSignal;
};

export type ProbeOllamaTargetResult = { report: OllamaProbeReport; key: EndpointKey; identity: string };

const CHAT_PATH = '/api/chat';
const CACHE_PROBE_OUTPUT_TOKENS = 1;
const VERSION_PATH = '/api/version';
const TAGS_PATH = '/api/tags';

const withClient = async <T>(
  upstream: UpstreamEndpoint,
  ports: ProbePorts,
  signal: AbortSignal,
  use: (client: ProbeClient) => Promise<T>,
  timeoutMs: number = IDENTITY_READ_TIMEOUT_MS,
): Promise<T> => {
  const client = createProbeClient(probeEndpointOf(upstream, undefined), signal, timeoutMs, ports.timers);
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
  return parseExternalJson(result.text);
};

const versionOf = (body: unknown): string | undefined => {
  const version = isRecord(body) ? body['version'] : undefined;
  return typeof version === 'string' ? version : undefined;
};

export const answersAsOllama = (upstream: UpstreamEndpoint, ports: ProbePorts, signal: AbortSignal): Promise<boolean> =>
  withClient(upstream, ports, signal, async (client) => {
    const result = await client.request('GET', VERSION_PATH);
    return result.status === 200 && versionOf(usableUpstreamJson(result.text)) !== undefined;
  });

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

export const readOllamaDigest = (upstream: UpstreamEndpoint, ports: ProbePorts, model: string, signal: AbortSignal): Promise<string | undefined> =>
  withClient(upstream, ports, signal, async (client) => digestIn(await jsonOf(client, 'GET', TAGS_PATH), model));

const OLLAMA_DETAILS = (() => {
  const details = SERVER_KINDS.find((kind) => kind.kind === 'ollama')?.read?.details;
  if (details === undefined) throw new Error('the server kinds have no Ollama details read');
  return details;
})();

type OllamaShow = { trained: number; capabilities: readonly string[] };

const ollamaShowOf = async (client: ProbeClient, model: string): Promise<OllamaShow> => {
  const details = await readModelDetails((method, path, body) => jsonOf(client, method, path, body), OLLAMA_DETAILS, model);
  if (details?.window === undefined) throw new Error(`${OLLAMA_DETAILS.path} for model ${model} carries no context length`);
  if (details.capabilities === undefined) throw new Error(`${OLLAMA_DETAILS.path} for model ${model} carries no capabilities list`);
  return { trained: details.window, capabilities: details.capabilities };
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
      return promptEvalCountOf(parseExternalJson(result.text));
    },
    cost: async (imageUrl) => {
      const result = await send(imageUrl);
      if (result.status === 400) return { rejected: true };
      if (result.status !== 200) throw new UpstreamHttpError(result.status, null, `POST ${CHAT_PATH} was refused for an image token measurement: ${result.text}`, undefined, false);
      return { rejected: false, promptTokens: promptEvalCountOf(parseExternalJson(result.text)) };
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

const askJsonOnly = async (client: ProbeClient, model: string, contextWindow: number): Promise<JsonModeAnswer> => {
  const request = { ...JSON_MODE_PROBE_REQUEST, model };
  const body = buildOllamaChatBody(request, { contextWindow, maxOutputTokens: maxOutputTokensFor(contextWindow) }, false, NO_REASONING_IS_OWN, {
    jsonReply: jsonReplyPlanOf(request, { structuredOutput: 'none', jsonMode: 'json_object' }),
  });
  const result = await client.request('POST', CHAT_PATH, body);
  const parsed = usableUpstreamJson(result.text);
  if (result.status !== 200) return OLLAMA_VOCABULARY.kindOf(result.status, parsed) === 'unsupported' ? { kind: 'unsupported' } : { kind: 'failure' };
  if (!isRecord(parsed) || parsed['done_reason'] !== 'stop') return { kind: 'failure' };
  const message = parsed['message'];
  const content = isRecord(message) ? message['content'] : undefined;
  return { kind: 'complete', text: typeof content === 'string' ? content : '' };
};

const ABSENT_STATUSES: readonly number[] = [404, 501];

const ollamaTransport = (client: ProbeClient, model: string, contextWindow: number): SelectionTransport => ({
  legs: { responseFormat: true, tools: false },
  request: async (request) => {
    if (request.kind === 'tools' || request.kind === 'construct-tools') throw new Error('the Ollama dialect step has no tools leg');
    const result = await client.request('POST', CHAT_PATH, {
      model,
      messages: messagesOf(request),
      stream: false,
      truncate: false,
      options: { num_ctx: contextWindow, num_predict: maxOutputTokensFor(contextWindow) },
      format: request.schema,
    });
    if (ABSENT_STATUSES.includes(result.status)) return { kind: 'absent' };
    if (result.status >= 400 && result.status < 500) return { kind: 'refused', detail: result.text.slice(0, 500) };
    if (result.status !== 200) throw new UpstreamHttpError(result.status, null, `POST ${CHAT_PATH} was refused for the dialect step: ${result.text}`, undefined, false);
    const message = field(parseExternalJson(result.text), 'message');
    const content = isRecord(message) ? message['content'] : undefined;
    return { kind: 'ok', content: typeof content === 'string' ? content : undefined };
  },
});

export type OllamaMeasurement = { report: OllamaProbeReport; identity: string };

export type MeasureOllamaOptions = Omit<ProbeOllamaTargetOptions, 'probeRecordDir' | 'lock' | 'key' | 'signal'>;

export const measureOllama =
  (options: MeasureOllamaOptions): MeasureProbe<EndpointLockKey, OllamaMeasurement> =>
  async ({ key, signal }) => {
    const { model, upstream } = options;
    const { version, show, tags } = await withClient(upstream, options.ports, signal, async (client) => ({
      version: await jsonOf(client, 'GET', VERSION_PATH),
      show: await ollamaShowOf(client, model),
      tags: await jsonOf(client, 'GET', TAGS_PATH),
    }));
    const serverVersion = versionOf(version);
    if (serverVersion === undefined) throw new Error(`the server at ${key.endpoint} did not answer ${VERSION_PATH} in Ollama's form`);
    const { trained, capabilities } = show;
    if (options.contextWindow > trained) {
      throw new Error(`the context window ${options.contextWindow} is above the trained context length ${trained} of model ${model}`);
    }
    const identity = digestIn(tags, model);
    if (identity === undefined) throw new Error(`the Ollama server does not list model ${model}; pull it with \`ollama pull ${model}\``);
    const imageInputAccepted = capabilities.includes('vision');
    const imageTokens = imageInputAccepted
      ? await withClient(upstream, options.ports, signal, (client) => measureImageTokens(imageCostProbeOf(client, model, options.contextWindow)), options.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS)
      : undefined;
    const promptCache = await withClient(upstream, options.ports, signal, (client) => measurePromptCache(client, model, options.contextWindow), options.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS);
    const jsonMode = await measureJsonMode(() => withClient(upstream, options.ports, signal, (client) => askJsonOnly(client, model, options.contextWindow), options.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS));
    const userDialects = options.userDialects ?? NO_USER_DIALECTS;
    const selection = await withClient(
      upstream,
      options.ports,
      signal,
      (client) =>
        selectDialect({
          transport: ollamaTransport(client, model, options.contextWindow),
          samples: options.samples ?? DEFAULT_SAMPLES,
          userDialects,
          declaredDialect: options.declaredDialect,
        }),
      options.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS,
    );
    const report: OllamaProbeReport = {
      kind: 'ollama',
      probedAt: new Date(options.ports.clock.now()).toISOString(),
      serverVersion,
      modelId: model,
      contextWindow: { value: trained, method: 'reported' },
      nativeTools: { accepted: capabilities.includes('tools') },
      imageInputAccepted,
      ...(imageTokens === undefined ? {} : { imageTokens }),
      thinkingSupported: capabilities.includes('thinking'),
      schemaDialect: selection.dialect,
      ...(promptCache === undefined ? {} : { promptCache }),
      jsonMode,
    };
    return { report, identity };
  };

export const ollamaPrecondition = (upstream: UpstreamEndpoint, ports: ProbePorts, model: string): ProbePrecondition => ({
  boundMs: IDENTITY_READ_TIMEOUT_MS,
  check: async (signal) => {
    const tags = await withClient(upstream, ports, signal, (client) => jsonOf(client, 'GET', TAGS_PATH));
    if (digestIn(tags, model) !== undefined) return { kind: 'met' };
    return { kind: 'refused', message: `the Ollama server does not list the model "${model}"`, detail: `GET ${TAGS_PATH} has no entry for it`, remedy: `ollama pull ${model}` };
  },
});

export type OllamaProbeSubjectOptions = {
  target: string;
  key: EndpointKey;
  probeRecordDir: string;
  lock: KernelLockMechanism;
  precondition: ProbePrecondition;
  measure: MeasureProbe<EndpointLockKey, OllamaMeasurement>;
  currency: DialectCurrency;
};

export const ollamaProbeSubject = (options: OllamaProbeSubjectOptions): ProbeSubject<EndpointLockKey, OllamaMeasurement> => ({
  target: options.target,
  readKey: async () => endpointLockKeyOf(options.key),
  precondition: options.precondition,
  measure: options.measure,
  save: (key, measured) => saveEndpointRecord(options.probeRecordDir, endpointKeyOfLock(key), measured.identity, [], measured.report, options.currency, options.lock),
});

export const probeOllamaTarget = async (options: ProbeOllamaTargetOptions): Promise<ProbeOllamaTargetResult> => {
  const subject = ollamaProbeSubject({
    target: endpointLockKeyOf(options.key).target,
    key: options.key,
    probeRecordDir: options.probeRecordDir,
    lock: options.lock,
    precondition: ollamaPrecondition(options.upstream, options.ports, options.model),
    measure: measureOllama(options),
    currency: {
      userDialects: options.userDialects ?? NO_USER_DIALECTS,
      probeMethod: PROBE_METHOD_VERSION,
      ...(options.declaredDialect === undefined ? {} : { declaredDialect: options.declaredDialect }),
    },
  });
  const { report: measured } = await recordProbe(subject, options.probeRecordDir, options.lock, options.ports.timers, options.signal ?? new AbortController().signal);
  return { report: measured.report, key: options.key, identity: measured.identity };
};
