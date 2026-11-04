import Ajv2020 from 'ajv/dist/2020.js';
import { decodeSse } from '@momonga/foundation';
import {
  ESTIMATED_ERROR_BOUND_RATIO,
  PROBE_KEYWORDS,
  SUMMARY_PROMPT_TOKENS,
  summaryInputLimitFor,
  summaryTokenCapFor,
  tokensForText,
  type ImageTokenModel,
  type ProbeKeyword,
  type ProbeReport,
} from '@momonga/protocol';
import { CHAT_COMPLETIONS_VOCABULARY } from '../adapters/chat-completions/vocabulary.ts';
import type { ErrorVocabulary } from '../adapters/chat-completions/vocabulary.ts';
import { decodeUpstreamReply } from '../adapters/chat-completions/upstream-reply.ts';
import type { UpstreamReply } from '../adapters/chat-completions/upstream-reply.ts';
import { summaryRequestOf } from '../adapters/shared/compact.ts';
import { hiddenReasoningTokens } from '../core/hidden-reasoning.ts';
import { maxOutputTokensFor } from './decide.ts';
import { solidPngDataUrl } from './solid-png.ts';
import { ProbeTimeoutError, createProbeClient, systemSleep, type HttpResult, type ProbeClient, type ProbeEndpoint } from './client.ts';
import { buildToolCallEnvelope, keywordProbeSchemas, type KeywordSupport, type ProbeTool } from './envelope.ts';
import { field, firstOf, isRecord, parseJson } from './json.ts';

export interface ProbeOptions {
  socketPath?: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  managedHealthRoute?: boolean;
  vocabulary?: ErrorVocabulary;
  model?: string;
  samples?: number;
  countTokens?: (text: string) => Promise<number>;
  guardrailPrompt?: string;
  now?: () => Date;
  signal?: AbortSignal;
  stepTimeoutMs?: number;
  sleep?: (ms: number, signal: AbortSignal | undefined) => Promise<void>;
}

const MAX_RATE_LIMIT_RETRIES = 3;
const DEFAULT_SAMPLES = 10;
const CONCURRENCY_ATTEMPTS = 8;
const SEARCH_INITIAL_WORDS = 64;
const SEARCH_MAX_WORDS = 262144;
const DEFAULT_STEP_TIMEOUT_MS = 120000;
const SEARCH_TOLERANCE = 0.01;
const CACHE_PROBE_WORDS = 1536;
const IMAGE_PROMPT = 'Describe this image.';
const IMAGE_PROBE_SMALL_SIDE = 512;
const IMAGE_PROBE_LARGE_SIDE = 2048;
const IMAGE_PROBE_MAX_SIDE = 8192;
const CALIBRATION_WORD_COUNTS = [20, 80, 320] as const;
const CONTEXT_FIELDS = [
  'context_window',
  'context_length',
  'max_context_length',
  'contextSize',
  'resolvedContextSize',
  'context_size',
] as const;

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
const TINY_PNG_SIDE = 1;
const TINY_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const ajv = new Ajv2020.default({ strict: false });
const validateToolArguments = ajv.compile(PROBE_TOOL.parameters);

type ProbeOutcome = 'accepted' | 'unsupported' | 'overflow' | 'failure';

type ChatResult = HttpResult & { reply: UpstreamReply; outcome: ProbeOutcome };

const outcomeOf = (vocabulary: ErrorVocabulary, status: number, reply: UpstreamReply): ProbeOutcome => {
  if (reply.kind === 'completion') return status === 200 ? 'accepted' : 'failure';
  const kind = vocabulary.kindOf(status, reply.body);
  if (kind === 'context_overflow') return 'overflow';
  return kind === 'unsupported' ? 'unsupported' : 'failure';
};

const reportsError = (result: HttpResult | ChatResult): boolean => 'reply' in result && result.reply.kind === 'error';

const expectStatus = (result: HttpResult | ChatResult, allowed: readonly number[], what: string): void => {
  if (!allowed.includes(result.status) || (result.status < 400 && reportsError(result))) {
    throw new Error(`Probe step "${what}" failed with HTTP ${result.status}: ${result.text.slice(0, 500)}`);
  }
};

const failProbeStep = (result: HttpResult, what: string): never => {
  throw new Error(`Probe step "${what}" failed with HTTP ${result.status}: ${result.text.slice(0, 500)}`);
};

const isAcceptedOrRejected = (result: ChatResult, what: string): boolean => {
  if (result.outcome === 'accepted') return true;
  if (result.outcome === 'unsupported') return false;
  return failProbeStep(result, what);
};

const isFirstSampleAccepted = (result: ChatResult | undefined, what: string): boolean => {
  if (result === undefined) throw new Error(`Probe step "${what}" timed out on its first sample`);
  return isAcceptedOrRejected(result, what);
};

const assistantMessage = (body: unknown): unknown => field(firstOf(field(body, 'choices')), 'message');

const promptTokensOf = (body: unknown): number | undefined => {
  const tokens = field(field(body, 'usage'), 'prompt_tokens');
  return typeof tokens === 'number' ? tokens : undefined;
};

const retryAfterMs = (value: string | undefined, now: Date): number | undefined => {
  if (value === undefined) return undefined;
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now.getTime());
};

const wordsOf = (count: number): string => Array.from({ length: count }, () => 'word').join(' ');

const cachedTokensOf = (reply: UpstreamReply): number | undefined => {
  if (reply.kind !== 'completion') return undefined;
  const cached = field(field(reply.usage, 'prompt_tokens_details'), 'cached_tokens');
  return typeof cached === 'number' ? cached : undefined;
};

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

const endpointOf = (options: ProbeOptions): ProbeEndpoint => {
  const { socketPath, baseUrl } = options;
  if ((socketPath === undefined) === (baseUrl === undefined)) throw new Error('A probe needs exactly one of socketPath and baseUrl');
  if (socketPath !== undefined) return { kind: 'unix', socketPath };
  return { kind: 'tcp', baseUrl: baseUrl as string, ...(options.headers === undefined ? {} : { headers: options.headers }) };
};

export const runProbe = async (options: ProbeOptions): Promise<ProbeReport> => {
  const client = createProbeClient(endpointOf(options), options.signal, options.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS, options.managedHealthRoute === true);
  try {
    return await probeWith(client, options);
  } finally {
    await client.close();
  }
};

const probeWith = async (client: ProbeClient, options: ProbeOptions): Promise<ProbeReport> => {
  const samples = options.samples ?? DEFAULT_SAMPLES;
  const now = options.now ?? (() => new Date());

  const healthResult: HttpResult = client.hasHealthRoute ? await client.get('health') : { status: 200, text: '', headers: {} };
  expectStatus(healthResult, [200], 'health');

  const modelsResult = await client.get('models');
  expectStatus(modelsResult, [200], 'models');
  const modelsBody = parseJson(modelsResult.text);
  const listedModel = firstOf(field(modelsBody, 'data'));
  const listedId = field(listedModel, 'id');
  const model = options.model ?? listedId;
  if (typeof model !== 'string') throw new Error('Probe could not determine a model id from /v1/models');

  const vocabulary = options.vocabulary ?? CHAT_COMPLETIONS_VOCABULARY;
  const post = async (body: Record<string, unknown>): Promise<ChatResult> => {
    const result = await client.post('chat', { model, ...body });
    const reply = await decodeUpstreamReply(result.status, result.text);
    return { ...result, reply, outcome: outcomeOf(vocabulary, result.status, reply) };
  };
  const stepTimeoutMs = options.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
  const sleep = options.sleep ?? systemSleep;
  const chat: Chat = async (body) => {
    let result = await post(body);
    for (let retry = 0; result.status === 429 && retry < MAX_RATE_LIMIT_RETRIES; retry += 1) {
      const waitMs = retryAfterMs(result.headers['retry-after'], now());
      if (waitMs === undefined || waitMs > stepTimeoutMs) return result;
      await sleep(waitMs, options.signal);
      result = await post(body);
    }
    return result;
  };

  const plain = await chat({ messages: [{ role: 'user', content: PLAIN_PROMPT }] });
  expectStatus(plain, [200], 'plain completion');
  const usageReported = promptTokensOf(parseJson(plain.text)) !== undefined;

  const streaming = await probeStreaming(client, model);

  const stopSequences = isAcceptedOrRejected(
    await chat({ messages: [{ role: 'user', content: PLAIN_PROMPT }], stop: ['STOP'] }),
    'stop sequences',
  );
  const imageInputAccepted = isAcceptedOrRejected(
    await imagePromptRequest(chat, TINY_PNG),
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
    ? await sampleConstrained(chat, samples, keywordSupport)
    : { accepted: false, validRate: 0 };
  const roundTripOk = native.firstValidCall === undefined ? false : await roundTrip(chat, native.firstValidCall);
  const parallelToolCalls = native.accepted ? await sampleParallel(chat, samples) : { accepted: false, multiCallRate: 0 };

  const tokenCalibration =
    usageReported && options.countTokens !== undefined ? await calibrate(chat, options.countTokens) : undefined;

  const contextWindow =
    reportedContextWindow(modelsBody, healthResult.text) ?? (await searchContextWindow(chat));

  const reasoning = await measureReasoning(chat, contextWindow.value);

  const promptCache = await measurePromptCache(chat);

  const maxConcurrency = await measureConcurrency(post);

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
    parallelToolCalls,
    reasoning,
    maxConcurrency,
    imageInputAccepted,
    ...(imageTokens === undefined ? {} : { imageTokens }),
    guardrail,
    ...(tokenCalibration === undefined ? {} : { tokenCalibration }),
    ...(promptCache === undefined ? {} : { promptCache }),
  };
};

type Chat = (body: Record<string, unknown>) => Promise<ChatResult>;

type ImageCost = { rejected: true } | { rejected: false; promptTokens: number | undefined };

type MeasuredImage = { side: number; tokens: number };

type Measurement = MeasuredImage | 'rejected' | 'unusable';

const imagePromptRequest = (chat: Chat, imageUrl: string | undefined): Promise<ChatResult> => {
  const parts: unknown[] = [{ type: 'text', text: IMAGE_PROMPT }];
  if (imageUrl !== undefined) parts.push({ type: 'image_url', image_url: { url: imageUrl } });
  return chat({ messages: [{ role: 'user', content: parts }], max_tokens: 1 });
};

const baselinePromptTokens = async (chat: Chat): Promise<number | undefined> => {
  const result = await imagePromptRequest(chat, undefined);
  expectStatus(result, [200], 'image token baseline');
  return promptTokensOf(parseJson(result.text));
};

const imageCost = async (chat: Chat, imageUrl: string): Promise<ImageCost> => {
  const result = await imagePromptRequest(chat, imageUrl);
  if (result.outcome === 'unsupported' || result.outcome === 'overflow') return { rejected: true };
  if (result.outcome !== 'accepted') return failProbeStep(result, 'image token measurement');
  return { rejected: false, promptTokens: promptTokensOf(parseJson(result.text)) };
};

const measureUrl = async (chat: Chat, baseline: number, side: number, imageUrl: string): Promise<Measurement> => {
  const cost = await imageCost(chat, imageUrl);
  if (cost.rejected) return 'rejected';
  if (cost.promptTokens === undefined || cost.promptTokens - baseline <= 0) return 'unusable';
  return { side, tokens: cost.promptTokens - baseline };
};

const measureSide = (chat: Chat, baseline: number, side: number): Promise<Measurement> => measureUrl(chat, baseline, side, solidPngDataUrl(side));

const bisectLargestAccepted = async (chat: Chat, baseline: number, accepted: MeasuredImage, rejectedFrom: number): Promise<MeasuredImage | undefined> => {
  let largest = accepted;
  let rejectedSide = rejectedFrom;
  while (rejectedSide - largest.side > Math.max(1, Math.floor(largest.side * SEARCH_TOLERANCE))) {
    const middle = Math.floor((largest.side + rejectedSide) / 2);
    const measured = await measureSide(chat, baseline, middle);
    if (measured === 'unusable') return undefined;
    if (measured === 'rejected') rejectedSide = middle;
    else largest = measured;
  }
  return largest;
};

type Ceiling = { largest: MeasuredImage; plateau: boolean };

const findCeiling = async (chat: Chat, baseline: number, small: MeasuredImage, floorTokens: number): Promise<Ceiling | undefined> => {
  let previous = small;
  for (let side = IMAGE_PROBE_LARGE_SIDE; side <= IMAGE_PROBE_MAX_SIDE; side *= 2) {
    const measured = await measureSide(chat, baseline, side);
    if (measured === 'unusable') return undefined;
    if (measured === 'rejected') {
      const largest = await bisectLargestAccepted(chat, baseline, previous, side);
      return largest === undefined ? undefined : { largest, plateau: false };
    }
    if (measured.tokens <= previous.tokens && previous.tokens > floorTokens) return { largest: measured, plateau: true };
    previous = measured;
  }
  return { largest: previous, plateau: false };
};

const referenceBelowPlateau = async (chat: Chat, baseline: number, start: MeasuredImage, model: Pick<ImageTokenModel, 'minTokens' | 'maxTokens'>, plateau: boolean): Promise<MeasuredImage | undefined> => {
  let candidate = start;
  for (;;) {
    if (candidate.tokens <= model.minTokens) return undefined;
    if (!plateau || candidate.tokens < model.maxTokens) return candidate;
    const side = Math.floor(candidate.side / 2);
    if (side < 1) return undefined;
    const measured = await measureSide(chat, baseline, side);
    if (measured === 'rejected' || measured === 'unusable') return undefined;
    candidate = measured;
  }
};

const measureImageTokens = async (chat: Chat): Promise<ImageTokenModel | undefined> => {
  const baseline = await baselinePromptTokens(chat);
  if (baseline === undefined) return undefined;
  const tiny = await measureUrl(chat, baseline, TINY_PNG_SIDE, TINY_PNG);
  if (tiny === 'rejected' || tiny === 'unusable') return undefined;
  const small = await measureSide(chat, baseline, IMAGE_PROBE_SMALL_SIDE);
  if (small === 'unusable') return undefined;
  const ceiling =
    small === 'rejected'
      ? { largest: await bisectLargestAccepted(chat, baseline, tiny, IMAGE_PROBE_SMALL_SIDE), plateau: false }
      : await findCeiling(chat, baseline, small, tiny.tokens);
  if (ceiling?.largest === undefined || ceiling.largest.side === tiny.side) return undefined;
  const { largest, plateau } = ceiling;
  const model = { minTokens: tiny.tokens, maxTokens: largest.tokens };
  const start = small === 'rejected' ? largest : small;
  const reference = model.minTokens === model.maxTokens ? start : await referenceBelowPlateau(chat, baseline, start, model, plateau);
  if (reference === undefined) return undefined;
  return { pixelsPerToken: reference.side ** 2 / reference.tokens, ...model };
};

const measurePromptCache = async (chat: Chat): Promise<ProbeReport['promptCache']> => {
  const request = { messages: [{ role: 'user', content: wordsOf(CACHE_PROBE_WORDS) }], max_tokens: 1 };
  expectStatus(await chat(request), [200], 'prompt cache first request');
  const repeated = await chat(request);
  expectStatus(repeated, [200], 'prompt cache repeated request');
  const cached = cachedTokensOf(repeated.reply);
  if (cached === undefined) return undefined;
  return { kind: cached > 0 ? 'automatic' : 'none' };
};

const probeStreaming = async (client: ProbeClient, model: string): Promise<ProbeReport['streaming']> => {
  const { status, chunks } = await client.stream('chat', {
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

const sampleRequest = async (chat: Chat, body: Record<string, unknown>): Promise<ChatResult | undefined> => {
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
    if (index === 0 && !isFirstSampleAccepted(result, 'native tools')) {
      return { accepted: false, validRate: 0, firstValidCall: undefined };
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

const sampleConstrained = async (
  chat: Chat,
  samples: number,
  support: KeywordSupport,
): Promise<NonNullable<ProbeReport['constrained']>> => {
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
    if (index === 0 && !isFirstSampleAccepted(result, 'constrained samples')) return { accepted: false, validRate: 0 };
    if (result === undefined || result.status !== 200) continue;
    if (constrainedValid(parseJson(result.text))) valid += 1;
  }
  return { accepted: true, validRate: samples === 0 ? 0 : valid / samples };
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
  if (result.outcome === 'unsupported') return false;
  expectStatus(result, [200], 'native round trip');
  const content = field(assistantMessage(parseJson(result.text)), 'content');
  return typeof content === 'string' && content.length > 0;
};

const PARALLEL_TOOL_PROMPT = `Please call ${PROBE_TOOL.name} for Tokyo for 3 days and also for Osaka for 2 days, both at once`;
const REASONING_BASELINE_SAMPLES = 2;
const REASONING_REDUCTION_FACTOR = 2;
const PROBED_REASONING_EFFORTS = ['none', 'minimal', 'low'] as const;

const nativeToolSpec = { type: 'function', function: { name: PROBE_TOOL.name, description: 'Get the weather', parameters: PROBE_TOOL.parameters } };

const toolCallCount = (body: unknown): number => {
  const calls = field(assistantMessage(body), 'tool_calls');
  return Array.isArray(calls) && calls.every((call) => field(field(call, 'function'), 'name') === PROBE_TOOL.name) ? calls.length : 0;
};

const sampleParallel = async (chat: Chat, samples: number): Promise<NonNullable<ProbeReport['parallelToolCalls']>> => {
  let several = 0;
  for (let index = 0; index < samples; index += 1) {
    const result = await sampleRequest(chat, {
      messages: [{ role: 'user', content: PARALLEL_TOOL_PROMPT }],
      tools: [nativeToolSpec],
      parallel_tool_calls: true,
    });
    if (index === 0 && !isFirstSampleAccepted(result, 'parallel tool calls')) return { accepted: false, multiCallRate: 0 };
    if (result === undefined || result.status !== 200) continue;
    if (toolCallCount(parseJson(result.text)) >= 2) several += 1;
  }
  return { accepted: true, multiCallRate: samples === 0 ? 0 : several / samples };
};

const numberOf = (value: unknown): number | undefined => (typeof value === 'number' ? value : undefined);

const stringOf = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

const hiddenReasoningOf = (body: unknown): number | undefined => {
  const message = assistantMessage(body);
  const usage = field(body, 'usage');
  return hiddenReasoningTokens({
    reportedReasoningTokens: numberOf(field(field(usage, 'completion_tokens_details'), 'reasoning_tokens')),
    reasoningText: stringOf(field(message, 'reasoning_content')) ?? stringOf(field(message, 'reasoning')),
    completionTokens: numberOf(field(usage, 'completion_tokens')),
    visibleText: stringOf(field(message, 'content')) ?? '',
  });
};

const FILLER_SENTENCE = 'The build log lists every file the tool read and every command it ran. ';

const summaryShapedBody = (contextWindow: number): Record<string, unknown> => {
  const maxOutputTokens = maxOutputTokensFor(contextWindow);
  const cap = summaryTokenCapFor({ contextWindow });
  const limit = summaryInputLimitFor({ contextWindow, maxOutputTokens }, cap, 0);
  const transcriptTokens = Math.max(1, Math.floor(limit / (1 + ESTIMATED_ERROR_BOUND_RATIO)) - SUMMARY_PROMPT_TOKENS);
  const transcript = FILLER_SENTENCE.repeat(Math.ceil(transcriptTokens / tokensForText(FILLER_SENTENCE)));
  const summary = summaryRequestOf(
    { model: '', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: transcript }] }] },
    cap,
  );
  const content = (summary.input[0] as { content: unknown }).content;
  return {
    messages: [
      { role: 'system', content: summary.instructions },
      { role: 'user', content },
    ],
    max_tokens: maxOutputTokens,
  };
};

const measureReasoning = async (chat: Chat, contextWindow: number): Promise<NonNullable<ProbeReport['reasoning']>> => {
  const body = summaryShapedBody(contextWindow);
  const baseline: number[] = [];
  for (let index = 0; index < REASONING_BASELINE_SAMPLES; index += 1) {
    const result = await chat(body);
    expectStatus(result, [200], 'reasoning baseline');
    const spent = hiddenReasoningOf(parseJson(result.text));
    if (spent === undefined) return { control: 'none' };
    baseline.push(spent);
  }
  const headroomTokens = Math.max(...baseline);
  const lowestBaseline = Math.min(...baseline);
  for (const effort of PROBED_REASONING_EFFORTS) {
    const result = await chat({ ...body, reasoning_effort: effort });
    if (!isAcceptedOrRejected(result, 'reasoning')) continue;
    const spent = hiddenReasoningOf(parseJson(result.text));
    if (headroomTokens === 0 || (spent !== undefined && spent * REASONING_REDUCTION_FACTOR <= lowestBaseline)) {
      return { control: 'reasoning_effort', lowest: effort };
    }
  }
  return { control: 'none', headroomTokens };
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
    const { reply } = result;
    if (reply.kind === 'completion') {
      if (result.outcome !== 'accepted') return failProbeStep(result, 'context window search');
      return { ok: true, promptTokens: promptTokensOf({ usage: reply.usage }) ?? words };
    }
    if (result.outcome !== 'overflow') return failProbeStep(result, 'context window search');
    if (!overflowRecorded) {
      overflowRecorded = true;
      overflowErrorShape = reply.body;
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
  const request = (): Promise<ChatResult> => chat({ messages: [{ role: 'user', content: PLAIN_PROMPT }] });
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
