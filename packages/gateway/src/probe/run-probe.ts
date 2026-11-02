import Ajv2020 from 'ajv/dist/2020.js';
import { decodeSse } from '@momonga/foundation';
import { PROBE_KEYWORDS, type ImageTokenModel, type ProbeKeyword, type ProbeReport } from '@momonga/protocol';
import { solidPngDataUrl } from './solid-png.ts';
import { ProbeTimeoutError, createProbeClient, type HttpResult, type ProbeClient } from './client.ts';
import { buildToolCallEnvelope, keywordProbeSchemas, type KeywordSupport, type ProbeTool } from './envelope.ts';
import { field, firstOf, isRecord, parseJson } from './json.ts';

export interface ProbeOptions {
  socketPath: string;
  model?: string;
  samples?: number;
  countTokens?: (text: string) => Promise<number>;
  guardrailPrompt?: string;
  now?: () => Date;
  signal?: AbortSignal;
  stepTimeoutMs?: number;
}

const DEFAULT_SAMPLES = 10;
const CONCURRENCY_ATTEMPTS = 8;
const SEARCH_INITIAL_WORDS = 64;
const SEARCH_MAX_WORDS = 262144;
const DEFAULT_STEP_TIMEOUT_MS = 120000;
const SEARCH_TOLERANCE = 0.01;
const IMAGE_PROMPT = 'Describe this image.';
const IMAGE_PROBE_SMALL_SIDE = 512;
const IMAGE_PROBE_LARGE_SIDE = 2048;
const IMAGE_CAP_DETECTION_MARGIN = 0.1;
const CALIBRATION_WORD_COUNTS = [20, 80, 320] as const;
const CONTEXT_FIELDS = [
  'context_window',
  'context_length',
  'max_context_length',
  'contextSize',
  'resolvedContextSize',
  'context_size',
] as const;
const NON_OVERFLOW_CLIENT_ERRORS = new Set([408, 429]);

const PROBE_TOOL: ProbeTool = {
  name: 'probe_weather',
  parameters: {
    type: 'object',
    properties: { city: { type: 'string' }, days: { type: 'integer', minimum: 1 } },
    required: ['city', 'days'],
    additionalProperties: false,
  },
};
const TOOL_PROMPT = `Please call ${PROBE_TOOL.name} for Tokyo for 3 days`;
const SYSTEM_PROMPT = 'Answer only with JSON that matches the given schema.';
const PLAIN_PROMPT = 'Say hello in one short sentence.';
const TINY_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const ajv = new Ajv2020.default({ strict: false });
const validateToolArguments = ajv.compile(PROBE_TOOL.parameters);

const expectStatus = (result: HttpResult, allowed: readonly number[], what: string): void => {
  if (!allowed.includes(result.status)) {
    throw new Error(`Probe step "${what}" failed with HTTP ${result.status}: ${result.text.slice(0, 500)}`);
  }
};

const isAcceptedOrRejected = (result: HttpResult, what: string): boolean => {
  expectStatus(result, [200, 400], what);
  return result.status === 200;
};

const assistantMessage = (body: unknown): unknown => field(firstOf(field(body, 'choices')), 'message');

const promptTokensOf = (body: unknown): number | undefined => {
  const tokens = field(field(body, 'usage'), 'prompt_tokens');
  return typeof tokens === 'number' ? tokens : undefined;
};

const wordsOf = (count: number): string => Array.from({ length: count }, () => 'word').join(' ');

const toolArgumentsValid = (args: unknown): boolean => isRecord(args) && validateToolArguments(args);

interface NativeCall {
  id: string;
  name: string;
  arguments: string;
}

const nativeCallOf = (body: unknown): NativeCall | undefined => {
  const call = firstOf(field(assistantMessage(body), 'tool_calls'));
  const fn = field(call, 'function');
  const id = field(call, 'id');
  const name = field(fn, 'name');
  const args = field(fn, 'arguments');
  if (typeof id !== 'string' || typeof name !== 'string' || typeof args !== 'string') return undefined;
  return { id, name, arguments: args };
};

const nativeCallValid = (call: NativeCall | undefined): boolean =>
  call !== undefined && call.name === PROBE_TOOL.name && toolArgumentsValid(parseJson(call.arguments));

const constrainedValid = (body: unknown): boolean => {
  const content = field(assistantMessage(body), 'content');
  if (typeof content !== 'string') return false;
  const envelope = parseJson(content);
  if (field(envelope, 'kind') !== 'tool_calls') return false;
  const call = firstOf(field(envelope, 'calls'));
  return field(call, 'name') === PROBE_TOOL.name && toolArgumentsValid(field(call, 'arguments'));
};

const responseFormat = (schema: unknown): unknown => ({
  type: 'json_schema',
  json_schema: { name: 'probe', strict: true, schema },
});

export const runProbe = async (options: ProbeOptions): Promise<ProbeReport> => {
  const client = createProbeClient(
    options.socketPath,
    options.signal,
    options.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS,
  );
  try {
    return await probeWith(client, options);
  } finally {
    await client.close();
  }
};

const probeWith = async (client: ProbeClient, options: ProbeOptions): Promise<ProbeReport> => {
  const samples = options.samples ?? DEFAULT_SAMPLES;
  const now = options.now ?? (() => new Date());

  const healthResult = await client.get('/health');
  expectStatus(healthResult, [200], 'health');

  const modelsResult = await client.get('/v1/models');
  expectStatus(modelsResult, [200], 'models');
  const modelsBody = parseJson(modelsResult.text);
  const listedModel = firstOf(field(modelsBody, 'data'));
  const listedId = field(listedModel, 'id');
  const model = options.model ?? listedId;
  if (typeof model !== 'string') throw new Error('Probe could not determine a model id from /v1/models');

  const chat = (body: Record<string, unknown>): Promise<HttpResult> =>
    client.post('/v1/chat/completions', { model, ...body });

  const plain = await chat({ messages: [{ role: 'user', content: PLAIN_PROMPT }] });
  expectStatus(plain, [200], 'plain completion');
  const usageReported = promptTokensOf(parseJson(plain.text)) !== undefined;

  const streaming = await probeStreaming(client, model);

  const stopSequences = isAcceptedOrRejected(
    await chat({ messages: [{ role: 'user', content: PLAIN_PROMPT }], stop: ['STOP'] }),
    'stop sequences',
  );
  const imageInputAccepted = isAcceptedOrRejected(
    await chat({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Describe this image.' },
            { type: 'image_url', image_url: { url: TINY_PNG } },
          ],
        },
      ],
    }),
    'image input',
  );

  const imageTokens = imageInputAccepted && usageReported ? await measureImageTokens(chat) : undefined;

  const guardrail: ProbeReport['guardrail'] = {};
  if (options.guardrailPrompt !== undefined) {
    const result = await chat({ messages: [{ role: 'user', content: options.guardrailPrompt }] });
    expectStatus(result, [200, 400], 'guardrail');
    if (result.status === 400) guardrail.errorShape = parseJson(result.text);
  }

  const constrainedAccepted = isAcceptedOrRejected(
    await chat({
      messages: [{ role: 'user', content: PLAIN_PROMPT }],
      response_format: responseFormat({ type: 'object', properties: { ok: { type: 'string' } }, required: ['ok'] }),
    }),
    'json_schema baseline',
  );

  const keywordSupport = Object.fromEntries(PROBE_KEYWORDS.map((keyword) => [keyword, false])) as KeywordSupport;
  if (constrainedAccepted) {
    for (const keyword of PROBE_KEYWORDS) {
      keywordSupport[keyword] = await probeKeyword(chat, keyword);
    }
  }

  const native = await sampleNative(chat, samples);
  const constrained = constrainedAccepted
    ? { accepted: true, validRate: await sampleConstrained(chat, samples, keywordSupport) }
    : { accepted: false, validRate: 0 };
  const roundTripOk = native.firstValidCall === undefined ? false : await roundTrip(chat, native.firstValidCall);

  const tokenCalibration =
    usageReported && options.countTokens !== undefined ? await calibrate(chat, options.countTokens) : undefined;

  const contextWindow =
    reportedContextWindow(modelsBody, healthResult.text) ?? (await searchContextWindow(chat));

  const maxConcurrency = await measureConcurrency(chat);

  return {
    probedAt: now().toISOString(),
    health: { ok: true },
    modelId: model,
    contextWindow,
    streaming,
    usageReported,
    nativeTools: { accepted: native.accepted, validRate: native.validRate, roundTripOk },
    constrained,
    keywordSupport,
    stopSequences,
    maxConcurrency,
    imageInputAccepted,
    ...(imageTokens === undefined ? {} : { imageTokens }),
    guardrail,
    ...(tokenCalibration === undefined ? {} : { tokenCalibration }),
  };
};

type Chat = (body: Record<string, unknown>) => Promise<HttpResult>;

const imagePromptTokens = async (chat: Chat, side: number | undefined): Promise<number | undefined> => {
  const parts: unknown[] = [{ type: 'text', text: IMAGE_PROMPT }];
  if (side !== undefined) parts.push({ type: 'image_url', image_url: { url: solidPngDataUrl(side) } });
  const result = await chat({ messages: [{ role: 'user', content: parts }] });
  expectStatus(result, [200], 'image token measurement');
  return promptTokensOf(parseJson(result.text));
};

const measureImageTokens = async (chat: Chat): Promise<ImageTokenModel | undefined> => {
  const baseline = await imagePromptTokens(chat, undefined);
  const small = await imagePromptTokens(chat, IMAGE_PROBE_SMALL_SIDE);
  const large = await imagePromptTokens(chat, IMAGE_PROBE_LARGE_SIDE);
  if (baseline === undefined || small === undefined || large === undefined) return undefined;
  const smallTokens = small - baseline;
  const largeTokens = large - baseline;
  if (smallTokens <= 0) return undefined;
  const pixelsPerToken = IMAGE_PROBE_SMALL_SIDE ** 2 / smallTokens;
  const uncappedLargeTokens = IMAGE_PROBE_LARGE_SIDE ** 2 / pixelsPerToken;
  if (largeTokens > uncappedLargeTokens * (1 - IMAGE_CAP_DETECTION_MARGIN)) return undefined;
  return { pixelsPerToken, maxTokens: largeTokens };
};

const probeStreaming = async (client: ProbeClient, model: string): Promise<ProbeReport['streaming']> => {
  const { status, chunks } = await client.stream('/v1/chat/completions', {
    model,
    messages: [{ role: 'user', content: PLAIN_PROMPT }],
    stream: true,
    stream_options: { include_usage: true },
  });
  if (status !== 200) {
    for await (const chunk of chunks) void chunk;
    if (status !== 400) throw new Error(`Probe step "streaming" failed with HTTP ${status}`);
    return { supported: false, doneSentinel: false, usageInStream: false };
  }
  let events = 0;
  let doneSentinel = false;
  let usageInStream = false;
  for await (const event of decodeSse(chunks)) {
    events += 1;
    if (event.data === '[DONE]') {
      doneSentinel = true;
      continue;
    }
    const usage = field(parseJson(event.data), 'usage');
    if (isRecord(usage)) usageInStream = true;
  }
  return { supported: events > 0, doneSentinel, usageInStream };
};

const probeKeyword = async (chat: Chat, keyword: ProbeKeyword): Promise<boolean> =>
  isAcceptedOrRejected(
    await chat({
      messages: [{ role: 'user', content: PLAIN_PROMPT }],
      response_format: responseFormat(keywordProbeSchemas[keyword]),
    }),
    `keyword ${keyword}`,
  );

const sampleRequest = async (chat: Chat, body: Record<string, unknown>): Promise<HttpResult | undefined> => {
  try {
    return await chat(body);
  } catch (error) {
    if (error instanceof ProbeTimeoutError) return undefined;
    throw error;
  }
};

const sampleNative = async (
  chat: Chat,
  samples: number,
): Promise<{ accepted: boolean; validRate: number; firstValidCall: NativeCall | undefined }> => {
  let valid = 0;
  let firstValidCall: NativeCall | undefined;
  for (let index = 0; index < samples; index += 1) {
    const result = await sampleRequest(chat, {
      messages: [{ role: 'user', content: TOOL_PROMPT }],
      tools: [{ type: 'function', function: { name: PROBE_TOOL.name, description: 'Get the weather', parameters: PROBE_TOOL.parameters } }],
    });
    if (index === 0) {
      if (result === undefined) throw new Error('Probe step "native tools" timed out on its first sample');
      expectStatus(result, [200, 400], 'native tools');
      if (result.status === 400) return { accepted: false, validRate: 0, firstValidCall: undefined };
    }
    if (result === undefined || result.status !== 200) continue;
    const call = nativeCallOf(parseJson(result.text));
    if (nativeCallValid(call)) {
      valid += 1;
      firstValidCall ??= call;
    }
  }
  return { accepted: true, validRate: samples === 0 ? 0 : valid / samples, firstValidCall };
};

const sampleConstrained = async (chat: Chat, samples: number, support: KeywordSupport): Promise<number> => {
  const format = responseFormat(buildToolCallEnvelope(PROBE_TOOL, support));
  let valid = 0;
  for (let index = 0; index < samples; index += 1) {
    const result = await sampleRequest(chat, {
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: TOOL_PROMPT },
      ],
      response_format: format,
    });
    if (result === undefined || result.status !== 200) continue;
    if (constrainedValid(parseJson(result.text))) valid += 1;
  }
  return samples === 0 ? 0 : valid / samples;
};

const roundTrip = async (chat: Chat, call: NativeCall): Promise<boolean> => {
  const result = await chat({
    messages: [
      { role: 'user', content: TOOL_PROMPT },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } }],
      },
      { role: 'tool', tool_call_id: call.id, content: 'Sunny, 24 degrees' },
    ],
    tools: [{ type: 'function', function: { name: PROBE_TOOL.name, description: 'Get the weather', parameters: PROBE_TOOL.parameters } }],
  });
  if (result.status === 400) return false;
  expectStatus(result, [200], 'native round trip');
  const content = field(assistantMessage(parseJson(result.text)), 'content');
  return typeof content === 'string' && content.length > 0;
};

const calibrate = async (
  chat: Chat,
  countTokens: (text: string) => Promise<number>,
): Promise<{ ratio: number; errorBound: number }> => {
  const points: Array<{ reported: number; counted: number }> = [];
  for (const wordCount of CALIBRATION_WORD_COUNTS) {
    const text = wordsOf(wordCount);
    const result = await chat({ messages: [{ role: 'user', content: text }] });
    expectStatus(result, [200], 'token calibration');
    const reported = promptTokensOf(parseJson(result.text));
    if (reported === undefined) throw new Error('Probe token calibration: usage.prompt_tokens missing');
    const counted = await countTokens(text);
    if (!(counted > 0)) throw new Error('Probe token calibration: countTokens returned a non-positive count');
    points.push({ reported, counted });
  }
  const totalReported = points.reduce((sum, point) => sum + point.reported, 0);
  const totalCounted = points.reduce((sum, point) => sum + point.counted, 0);
  const ratio = totalReported / totalCounted;
  const errorBound = Math.max(...points.map((point) => Math.abs(point.reported / point.counted - ratio) / ratio));
  return { ratio, errorBound };
};

const findContextValue = (source: unknown): number | undefined => {
  const queue: unknown[] = [source];
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const node = queue[cursor];
    if (Array.isArray(node)) {
      queue.push(...node);
      continue;
    }
    if (!isRecord(node)) continue;
    for (const name of CONTEXT_FIELDS) {
      const value = node[name];
      if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
    }
    queue.push(...Object.values(node));
  }
  return undefined;
};

const reportedContextWindow = (modelsBody: unknown, healthText: string): ProbeReport['contextWindow'] | undefined => {
  for (const source of [firstOf(field(modelsBody, 'data')), parseJson(healthText)]) {
    const value = findContextValue(source);
    if (value !== undefined) return { value, method: 'reported' };
  }
  return undefined;
};

const searchContextWindow = async (chat: Chat): Promise<ProbeReport['contextWindow']> => {
  let overflowErrorShape: unknown;
  let overflowRecorded = false;

  const attempt = async (words: number): Promise<{ ok: boolean; promptTokens: number }> => {
    const result = await chat({ messages: [{ role: 'user', content: wordsOf(words) }], max_tokens: 1 });
    if (result.status === 200) return { ok: true, promptTokens: promptTokensOf(parseJson(result.text)) ?? words };
    const rejectedAsTooLarge =
      result.status >= 400 && result.status < 500 && !NON_OVERFLOW_CLIENT_ERRORS.has(result.status);
    if (!rejectedAsTooLarge) expectStatus(result, [200], 'context window search');
    if (!overflowRecorded) {
      overflowRecorded = true;
      overflowErrorShape = parseJson(result.text) ?? result.text;
    }
    return { ok: false, promptTokens: 0 };
  };

  let low = 0;
  let lowTokens = 0;
  let high = SEARCH_INITIAL_WORDS;
  for (;;) {
    const outcome = await attempt(high);
    if (!outcome.ok) break;
    low = high;
    lowTokens = outcome.promptTokens;
    if (high >= SEARCH_MAX_WORDS) throw new Error('Probe context window search exceeded the maximum prompt size');
    high *= 2;
  }
  while (high - low > Math.max(1, Math.floor(low * SEARCH_TOLERANCE))) {
    const middle = Math.floor((low + high) / 2);
    const outcome = await attempt(middle);
    if (outcome.ok) {
      low = middle;
      lowTokens = outcome.promptTokens;
    } else {
      high = middle;
    }
  }
  if (low === 0) throw new Error('Probe context window search: even the smallest prompt was rejected');
  return {
    value: lowTokens + 1,
    method: 'searched',
    ...(overflowRecorded ? { overflowErrorShape } : {}),
  };
};

const measureConcurrency = async (chat: Chat): Promise<number> => {
  const request = (): Promise<HttpResult> => chat({ messages: [{ role: 'user', content: PLAIN_PROMPT }] });
  expectStatus(await request(), [200], 'concurrency warm-up');
  const singleStartedAt = performance.now();
  expectStatus(await request(), [200], 'concurrency baseline');
  const singleMs = performance.now() - singleStartedAt;
  const parallelStartedAt = performance.now();
  const results = await Promise.all(Array.from({ length: CONCURRENCY_ATTEMPTS }, request));
  const parallelMs = performance.now() - parallelStartedAt;
  for (const result of results) expectStatus(result, [200, 429], 'concurrency');
  const successCount = results.filter((result) => result.status === 200).length;
  const overlap = Math.floor((CONCURRENCY_ATTEMPTS * singleMs) / parallelMs);
  return Math.max(1, Math.min(overlap, successCount));
};
