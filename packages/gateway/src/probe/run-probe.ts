import { decodeSse, defineProductSchema } from '@momonga/foundation';
import type { ProductValidator } from '@momonga/foundation';
import {
  ESTIMATED_ERROR_BOUND_RATIO,
  DEFAULT_DIALECT_ID,
  DEFAULT_OUTPUT_BOUND_FIELD,
  OUTPUT_BOUND_FIELDS,
  SUMMARY_PROMPT_TOKENS,
  summaryInputLimitFor,
  summaryTokenCapFor,
  tokensForText,
  type DialectId,
  type ImageTokenModel,
  type OutputBoundField,
  type ProbeReport,
} from '@momonga/protocol';
import { CHAT_COMPLETIONS_VOCABULARY } from '../adapters/chat-completions/vocabulary.ts';
import type { ErrorVocabulary, UpstreamErrorKind } from '../adapters/shared/vocabulary.ts';
import { decodeUpstreamReply, upstreamErrorMessage } from '../adapters/chat-completions/upstream-reply.ts';
import type { UpstreamReply } from '../adapters/chat-completions/upstream-reply.ts';
import { outputBoundFor } from '../adapters/chat-completions/output-bound.ts';
import { summaryRequestOf } from '../adapters/shared/compact.ts';
import { NO_REASONING_IS_OWN } from '../adapters/shared/reasoning-origin.ts';
import { hiddenReasoningTokens } from '../core/hidden-reasoning.ts';
import { cachedCountOf } from './cached-count.ts';
import { maxOutputTokensFor } from './decide.ts';
import { IMAGE_PROMPT, SEARCH_TOLERANCE, TINY_PNG, measureImageTokens } from './image-tokens.ts';
import type { ImageCostProbe } from './image-tokens.ts';
import { ProbeTimeoutError, createProbeClient, systemSleep, type HttpResult, type ProbeClient, type ProbeEndpoint } from './client.ts';
import type { ProbeTool } from './envelope.ts';
import { NO_USER_DIALECTS, resolveDialect } from '../dialect/choice.ts';
import type { UserDialects } from '../dialect/choice.ts';
import { RenderLedger } from '../dialect/ledger.ts';
import type { ResolvedDialect } from '../dialect/render.ts';
import { renderToolParameters } from '../dialect/tool-render.ts';
import { invertReply } from '../dialect/unwrap.ts';
import { chatTransport, probeConstructs, probeKeywords, selectDialect } from './select-dialect.ts';
import { assistantMessage, errorKindOf, expectStatus, failProbeStep, isAcceptedOrRejected, isFirstSampleAccepted, outcomeOf, promptTokensOf, sampleRequest } from './probe-chat.ts';
import type { Chat, ChatResult, ProbeOutcome } from './probe-chat.ts';
import { fillerText } from './filler.ts';
import { field, firstOf, isRecord, parseJson } from './json.ts';

export interface ProbeOptions {
  socketPath?: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  managedHealthRoute?: boolean;
  vocabulary?: ErrorVocabulary;
  userDialects?: UserDialects;
  declaredDialect?: DialectId;
  model?: string;
  samples?: number;
  countTokens?: (text: string) => Promise<number>;
  guardrailPrompt?: string;
  now?: () => Date;
  signal?: AbortSignal;
  stepTimeoutMs?: number;
  sleep?: (ms: number, signal: AbortSignal | undefined) => Promise<void>;
}

export const PROBE_METHOD_VERSION = 1;

const MAX_RATE_LIMIT_RETRIES = 3;
export const DEFAULT_SAMPLES = 10;
const CONCURRENCY_ATTEMPTS = 8;
const SEARCH_INITIAL_WORDS = 64;
const SEARCH_MAX_WORDS = 262144;
const DEFAULT_STEP_TIMEOUT_MS = 120000;
const CACHE_PROBE_WORDS = 1536;
const OUTPUT_BOUND_PROBE_TOKENS = 16;
const OUTPUT_BOUND_HONOURED_FACTOR = 2;
const ONE_OUTPUT_TOKEN = 1;
const LONG_ANSWER_PROMPT = 'Count from 1 to 300, one number per line, and write nothing else.';
const CALIBRATION_WORD_COUNTS = [20, 80, 320] as const;
const CONTEXT_FIELDS = [
  'context_window',
  'context_length',
  'max_context_length',
  'contextSize',
  'resolvedContextSize',
  'context_size',
] as const;

const PROBE_PARAMETERS: Record<string, unknown> = {
  type: 'object',
  properties: { city: { type: 'string' }, days: { type: 'integer', minimum: 1 } },
  required: ['city', 'days'],
  additionalProperties: false,
};
const PROBE_TOOL: ProbeTool = { name: 'probe_weather', parameters: PROBE_PARAMETERS };
const TOOL_PROMPT = `Please call ${PROBE_TOOL.name} for Tokyo for 3 days`;
const PLAIN_PROMPT = 'Say hello in one short sentence.';
const validateToolArguments: ProductValidator<unknown> = defineProductSchema('gateway/probe-tool-arguments', PROBE_PARAMETERS);

const retryAfterMs = (value: string | undefined, now: Date): number | undefined => {
  if (value === undefined) return undefined;
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now.getTime());
};

const estimatedCount = async (text: string): Promise<number> => tokensForText(text);


const cachedTokensOf = (reply: UpstreamReply): number | undefined => {
  if (reply.kind !== 'completion') return undefined;
  return cachedCountOf(field(field(reply.usage, 'prompt_tokens_details'), 'cached_tokens'), 'usage.prompt_tokens_details.cached_tokens');
};

const toolArgumentsValid = (args: unknown): boolean => isRecord(args) && validateToolArguments(args).valid;

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

const nativeCallValid = (call: NativeCall | undefined, ledger: RenderLedger): boolean => {
  if (call === undefined || call.name !== PROBE_TOOL.name) return false;
  const record = ledger.wraps.get(call.name);
  return toolArgumentsValid(parseJson(record === undefined ? call.arguments : invertReply(record, call.arguments)));
};

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
  const send: Chat = async (body) => {
    const result = await client.post('chat', { model, ...body });
    const reply = await decodeUpstreamReply(result.status, result.text);
    const errorKind = errorKindOf(vocabulary, reply);
    return { ...result, reply, errorKind, outcome: outcomeOf(result.status, reply, errorKind) };
  };
  const stepTimeoutMs = options.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
  const sleep = options.sleep ?? systemSleep;
  const retryingRateLimits =
    (once: Chat): Chat =>
    async (body) => {
      let result = await once(body);
      for (let retry = 0; result.status === 429 && retry < MAX_RATE_LIMIT_RETRIES; retry += 1) {
        const waitMs = retryAfterMs(result.headers['retry-after'], now());
        if (waitMs === undefined || waitMs > stepTimeoutMs) return result;
        await sleep(waitMs, options.signal);
        result = await once(body);
      }
      return result;
    };

  const outputBoundField = await measureOutputBoundField(retryingRateLimits(send));
  const bound = { field: outputBoundField === 'none' ? DEFAULT_OUTPUT_BOUND_FIELD : outputBoundField, tokens: OUTPUT_BOUND_PROBE_TOKENS };
  const post: Chat = (body) => {
    const { outputTokens, ...rest } = body;
    return send({ ...rest, ...outputBoundFor(bound.field, typeof outputTokens === 'number' ? outputTokens : bound.tokens) });
  };
  const chat = retryingRateLimits(post);

  const contextWindow = reportedContextWindow(modelsBody, healthResult.text) ?? (await searchContextWindow(chat, options.countTokens));
  bound.tokens = maxOutputTokensFor(contextWindow.value);

  const plain = await chat({ messages: [{ role: 'user', content: PLAIN_PROMPT }] });
  expectStatus(plain, [200], 'plain completion');
  const usageReported = promptTokensOf(plain.reply.body) !== undefined;

  const streaming = await probeStreaming(client, model, outputBoundFor(bound.field, bound.tokens));

  const stopSequences = isAcceptedOrRejected(
    await chat({ messages: [{ role: 'user', content: PLAIN_PROMPT }], stop: ['STOP'] }),
    'stop sequences',
  );
  const imageInputAccepted = isAcceptedOrRejected(
    await imagePromptRequest(chat, TINY_PNG),
    'image input',
  );

  const imageTokens = imageInputAccepted && usageReported ? await measureImageTokens(imageCostProbeOf(chat)) : undefined;

  const guardrail: ProbeReport['guardrail'] = {};
  if (options.guardrailPrompt !== undefined) {
    const result = await chat({ messages: [{ role: 'user', content: options.guardrailPrompt }] });
    if (result.reply.kind === 'error' && (result.errorKind === 'guardrail' || result.status === 400)) {
      guardrail.errorShape = result.reply.body;
    } else {
      expectStatus(result, [200], 'guardrail');
    }
  }

  const transport = chatTransport(chat, { responseFormat: true, tools: true });
  const selection = await selectDialect({ transport, samples, userDialects: options.userDialects ?? NO_USER_DIALECTS, declaredDialect: options.declaredDialect });
  const { selected } = selection.dialect;
  const dialect = resolveDialect(selected ?? DEFAULT_DIALECT_ID, options.userDialects ?? NO_USER_DIALECTS);
  const keywordSupport = selected !== null && selection.legs.responseFormat ? await probeKeywords(chat, dialect) : undefined;
  const constructSupport = selected === null ? undefined : await probeConstructs(transport, dialect, selection.legs);

  const native = await sampleNative(chat, samples, dialect);
  const { constrained } = selection;
  const roundTripOk = native.firstValidCall === undefined ? false : await roundTrip(chat, native.firstValidCall, dialect);
  const parallelToolCalls = native.accepted ? await sampleParallel(chat, samples, dialect) : { accepted: false, multiCallRate: 0 };

  const tokenCalibration =
    usageReported && options.countTokens !== undefined ? await calibrate(chat, options.countTokens) : undefined;

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
    ...(keywordSupport === undefined ? {} : { keywordSupport }),
    ...(constructSupport === undefined ? {} : { constructSupport }),
    schemaDialect: selection.dialect,
    stopSequences,
    outputBoundField,
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

const outputTokensOf = (result: ChatResult): number => {
  const completionTokens = field(result.reply.kind === 'completion' ? result.reply.usage : undefined, 'completion_tokens');
  if (typeof completionTokens === 'number') return completionTokens;
  const content = field(assistantMessage(result.reply.body), 'content');
  if (typeof content === 'string') return tokensForText(content);
  return failProbeStep(result, 'output bound');
};

const honoursOutputBound = async (send: Chat, candidate: OutputBoundField): Promise<boolean> => {
  const result = await send({
    messages: [{ role: 'user', content: LONG_ANSWER_PROMPT }],
    ...outputBoundFor(candidate, OUTPUT_BOUND_PROBE_TOKENS),
  });
  if (!isAcceptedOrRejected(result, `output bound ${candidate}`)) return false;
  return outputTokensOf(result) <= OUTPUT_BOUND_PROBE_TOKENS * OUTPUT_BOUND_HONOURED_FACTOR;
};

const measureOutputBoundField = async (send: Chat): Promise<OutputBoundField | 'none'> => {
  for (const candidate of OUTPUT_BOUND_FIELDS) {
    if (await honoursOutputBound(send, candidate)) return candidate;
  }
  return 'none';
};

const imagePromptRequest = (chat: Chat, imageUrl: string | undefined): Promise<ChatResult> => {
  const parts: unknown[] = [{ type: 'text', text: IMAGE_PROMPT }];
  if (imageUrl !== undefined) parts.push({ type: 'image_url', image_url: { url: imageUrl } });
  return chat({ messages: [{ role: 'user', content: parts }], outputTokens: ONE_OUTPUT_TOKEN });
};

const imageCostProbeOf = (chat: Chat): ImageCostProbe => ({
  baseline: async () => {
    const result = await imagePromptRequest(chat, undefined);
    expectStatus(result, [200], 'image token baseline');
    return promptTokensOf(result.reply.body);
  },
  cost: async (imageUrl) => {
    const result = await imagePromptRequest(chat, imageUrl);
    if (result.outcome === 'unsupported' || result.outcome === 'overflow' || result.outcome === 'too_large') return { rejected: true };
    if (result.outcome !== 'accepted') return failProbeStep(result, 'image token measurement');
    return { rejected: false, promptTokens: promptTokensOf(result.reply.body) };
  },
});

const measurePromptCache = async (chat: Chat): Promise<ProbeReport['promptCache']> => {
  const request = { messages: [{ role: 'user', content: fillerText(CACHE_PROBE_WORDS) }], outputTokens: ONE_OUTPUT_TOKEN };
  expectStatus(await chat(request), [200], 'prompt cache first request');
  const repeated = await chat(request);
  expectStatus(repeated, [200], 'prompt cache repeated request');
  const cached = cachedTokensOf(repeated.reply);
  if (cached === undefined) return undefined;
  return { kind: cached > 0 ? 'automatic' : 'none' };
};

const probeStreaming = async (client: ProbeClient, model: string, outputBound: object): Promise<ProbeReport['streaming']> => {
  const { status, chunks } = await client.stream('chat', {
    model,
    messages: [{ role: 'user', content: PLAIN_PROMPT }],
    stream: true,
    stream_options: { include_usage: true },
    ...outputBound,
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

const sampleNative = async (
  chat: Chat,
  samples: number,
  dialect: ResolvedDialect,
): Promise<{ accepted: boolean; validRate: number; firstValidCall: NativeCall | undefined }> => {
  let valid = 0;
  let firstValidCall: NativeCall | undefined;
  const ledger = new RenderLedger();
  const spec = nativeToolSpec(dialect, ledger);
  for (let index = 0; index < samples; index += 1) {
    const result = await sampleRequest(chat, {
      messages: [{ role: 'user', content: TOOL_PROMPT }],
      tools: [spec],
    });
    if (index === 0 && !isFirstSampleAccepted(result, 'native tools')) {
      return { accepted: false, validRate: 0, firstValidCall: undefined };
    }
    if (result === undefined || result.status !== 200) continue;
    const call = nativeCallOf(result.reply.body);
    if (nativeCallValid(call, ledger)) {
      valid += 1;
      firstValidCall ??= call;
    }
  }
  return { accepted: true, validRate: samples === 0 ? 0 : valid / samples, firstValidCall };
};

const roundTrip = async (chat: Chat, call: NativeCall, dialect: ResolvedDialect): Promise<boolean> => {
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
    tools: [nativeToolSpec(dialect)],
  });
  if (result.outcome === 'unsupported') return false;
  expectStatus(result, [200], 'native round trip');
  const content = field(assistantMessage(result.reply.body), 'content');
  return typeof content === 'string' && content.length > 0;
};

const PARALLEL_TOOL_PROMPT = `Please call ${PROBE_TOOL.name} for Tokyo for 3 days and also for Osaka for 2 days, both at once`;
const REASONING_BASELINE_SAMPLES = 2;
const REASONING_REDUCTION_FACTOR = 2;
const PROBED_REASONING_EFFORTS = ['none', 'minimal', 'low'] as const;

const nativeToolSpec = (dialect: ResolvedDialect, ledger?: RenderLedger): Record<string, unknown> => {
  const { schema } = renderToolParameters(PROBE_TOOL, dialect, ledger);
  return { type: 'function', function: { name: PROBE_TOOL.name, description: 'Get the weather', ...(schema === undefined ? {} : { parameters: schema }) } };
};

const toolCallCount = (body: unknown): number => {
  const calls = field(assistantMessage(body), 'tool_calls');
  return Array.isArray(calls) && calls.every((call) => field(field(call, 'function'), 'name') === PROBE_TOOL.name) ? calls.length : 0;
};

const sampleParallel = async (chat: Chat, samples: number, dialect: ResolvedDialect): Promise<NonNullable<ProbeReport['parallelToolCalls']>> => {
  let several = 0;
  for (let index = 0; index < samples; index += 1) {
    const result = await sampleRequest(chat, {
      messages: [{ role: 'user', content: PARALLEL_TOOL_PROMPT }],
      tools: [nativeToolSpec(dialect)],
      parallel_tool_calls: true,
    });
    if (index === 0 && !isFirstSampleAccepted(result, 'parallel tool calls')) return { accepted: false, multiCallRate: 0 };
    if (result === undefined || result.status !== 200) continue;
    if (toolCallCount(result.reply.body) >= 2) several += 1;
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
    NO_REASONING_IS_OWN,
  );
  const content = (summary.input[0] as { content: unknown }).content;
  return {
    messages: [
      { role: 'system', content: summary.instructions },
      { role: 'user', content },
    ],
    outputTokens: maxOutputTokens,
  };
};

const measureReasoning = async (chat: Chat, contextWindow: number): Promise<NonNullable<ProbeReport['reasoning']>> => {
  const body = summaryShapedBody(contextWindow);
  const baseline: number[] = [];
  for (let index = 0; index < REASONING_BASELINE_SAMPLES; index += 1) {
    const result = await chat(body);
    expectStatus(result, [200], 'reasoning baseline');
    const spent = hiddenReasoningOf(result.reply.body);
    if (spent === undefined) return { control: 'none' };
    baseline.push(spent);
  }
  const headroomTokens = Math.max(...baseline);
  const lowestBaseline = Math.min(...baseline);
  for (const effort of PROBED_REASONING_EFFORTS) {
    const result = await chat({ ...body, reasoning_effort: effort });
    if (!isAcceptedOrRejected(result, 'reasoning')) continue;
    const spent = hiddenReasoningOf(result.reply.body);
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
    const text = fillerText(wordCount);
    const result = await chat({ messages: [{ role: 'user', content: text }] });
    expectStatus(result, [200], 'token calibration');
    const reported = promptTokensOf(result.reply.body);
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

const searchContextWindow = async (chat: Chat, countTokens: ProbeOptions['countTokens']): Promise<ProbeReport['contextWindow']> => {
  let overflowErrorShape: unknown;
  let overflowRecorded = false;

  const attempt = async (words: number): Promise<{ ok: boolean; promptTokens: number }> => {
    const text = fillerText(words);
    const result = await chat({ messages: [{ role: 'user', content: text }], outputTokens: ONE_OUTPUT_TOKEN });
    const { reply } = result;
    if (reply.kind === 'completion') {
      if (result.outcome !== 'accepted') return failProbeStep(result, 'context window search');
      const reported = promptTokensOf({ usage: reply.usage });
      if (reported !== undefined) return { ok: true, promptTokens: reported };
      return { ok: true, promptTokens: await (countTokens ?? estimatedCount)(text) };
    }
    if (result.outcome !== 'overflow') {
      throw new Error(
        `Probe step "context window search" at ${words} words got an upstream error of kind ${result.errorKind ?? 'failure'} (HTTP ${result.status}): ${upstreamErrorMessage(reply.body)}`,
      );
    }
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
