import fs from 'node:fs';
import http from 'node:http';
import type net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { tokensForText } from '@momonga/protocol';
import { collectAllowedNames, findUsedKeywords, generateInstance } from './schema-instance.ts';

export type FakeScenario = 'tools-ok' | 'tools-400' | 'tools-ignored' | 'json-schema-only' | 'none';

export interface FakeChatCompletionsOptions {
  scenario: FakeScenario;
  socketPath?: string;
  nativeValidity?: number;
  constrainedValidity?: number;
  unsupportedKeywords?: string[];
  contextWindow?: number;
  contextSizeExposure?: 'models' | 'health' | 'models-nested' | 'health-nested' | 'none';
  contextOverflowStatus?: 400 | 413 | 500;
  wire?: 'openai' | 'fm';
  modelId?: string;
  streamUsage?: boolean;
  usageReported?: boolean;
  stopSupported?: boolean;
  maxConcurrency?: number;
  overflow?: 'reject' | 'queue';
  imageInput?: boolean;
  imageTokens?: FakeImageTokenModel;
  imageSizeLimit?: { maxSide: number; status: 400 | 413 };
  rateLimitSizedImages?: { count: number; retryAfter: string };
  guardrailTrigger?: string;
  latencyMs?: number;
  reasoning?: { tokens: number; effort: 'honoured' | 'ignored' | 'rejected'; reportsUsage?: boolean; field?: 'reasoning_content' | 'reasoning' };
  parallelToolCalls?: boolean;
  models?: Array<Record<string, unknown>> | (() => Array<Record<string, unknown>>);
  modelsReply?: { kind: 'error'; status: number; body: unknown } | { kind: 'hang' };
  failNativeSamples?: number[];
  failConstrainedSamples?: number[];
  stallNativeSamples?: number[];
  stallMs?: number;
  healthy?: boolean;
  script?: FakeScriptedReply[];
  routes?: FakeRoute[];
}

export interface FakeRoute {
  match: (body: unknown) => boolean;
  reply: FakeScriptedReply | ((body: unknown) => FakeScriptedReply);
}

export interface FakeStreamChunk {
  delta: Record<string, unknown>;
  finishReason?: string | null;
}

export type FakeFixedUsage = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  completion_tokens_details?: { reasoning_tokens: number };
};

export type FakeUsageOfRequest = (requestBody: unknown) => FakeFixedUsage;

export type FakeScriptedReply =
  | {
      kind: 'stream';
      chunks: FakeStreamChunk[];
      usage?: FakeFixedUsage | FakeUsageOfRequest;
      done?: boolean;
    }
  | { kind: 'error'; status: number; body: unknown; headers?: Record<string, string> }
  | { kind: 'hang'; chunks?: FakeStreamChunk[] }
  | { kind: 'raw-sse'; events: string[] };

export interface RecordedRequest {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  body: unknown;
}

export interface FakeResponseHold {
  waitForRequest(): Promise<RecordedRequest>;
  release(): void;
}

export interface FakeChatCompletionsServer {
  socketPath: string;
  requests: RecordedRequest[];
  routeHits: number[];
  hold(): FakeResponseHold;
  openConnections(): number;
  disconnects(): number;
  close(): Promise<void>;
}

type Json = { [key: string]: unknown };

interface ChatMessage {
  role?: unknown;
  content?: unknown;
  tool_call_id?: unknown;
}

interface ToolCallOut {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface CompletionOut {
  content: string | null;
  toolCalls: ToolCallOut[];
  finishReason: 'stop' | 'tool_calls';
  delayMs?: number;
}

class FmStreamedError extends Error {
  readonly body: unknown;
  constructor(body: unknown) {
    super('fm streamed an error event');
    this.body = body;
  }
}

class HttpFailure extends Error {
  readonly status: number;
  readonly body: Json;
  readonly headers: Record<string, string>;
  constructor(status: number, body: Json, headers: Record<string, string> = {}) {
    super(String((body['error'] as Json | undefined)?.['message'] ?? status));
    this.status = status;
    this.body = body;
    this.headers = headers;
  }
}

export const JSON_OBJECT_UNSUPPORTED_MESSAGE =
  "response_format type 'json_object' is not supported. Use 'json_schema' instead.";
export const STOP_UNSUPPORTED_MESSAGE =
  "stop sequences are not supported. Truncate the model's output client-side.";
export const TOOLS_UNSUPPORTED_MESSAGE = 'tools are not supported by this model.';
export const JSON_SCHEMA_UNSUPPORTED_MESSAGE = "response_format type 'json_schema' is not supported.";
export const IMAGE_UNSUPPORTED_MESSAGE = 'image input is not supported by this model.';
export const FAKE_DETERMINISTIC_REPLY = 'This is a deterministic reply.';
export const FAKE_REASONING_WORD = 'step ';
export const FAKE_PAYLOAD_TOO_LARGE_ERROR = {
  error: { message: 'Request entity too large.', type: 'invalid_request_error', param: null, code: null },
} as const;
export const FM_CONTEXT_OVERFLOW_ERROR = {
  error: { type: 'server_error', code: '500', message: "The session's transcript exceeded the model's context size." },
} as const;
export const FM_UNSUPPORTED_GUIDE_ERROR = {
  error: { message: 'An unsupported generation guide was used.', code: '500', type: 'server_error' },
} as const;
export const FAKE_GUARDRAIL_ERROR = {
  error: {
    message: 'The request was blocked by the safety guardrail.',
    type: 'invalid_request_error',
    param: null,
    code: 'guardrail_violation',
  },
} as const;

const invalidRequest = (message: string, code: string | null = null, param: string | null = null): HttpFailure =>
  new HttpFailure(400, { error: { message, type: 'invalid_request_error', param, code } });

const isRecord = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const countFakeTokens = (text: string): number => (text.length === 0 ? 0 : tokensForText(text));

const messageText = (message: ChatMessage): string => {
  if (typeof message.content === 'string') return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .flatMap((part: unknown) => (isRecord(part) && typeof part['text'] === 'string' ? [part['text']] : []))
      .join(' ');
  }
  return '';
};

export interface FakeImageTokenModel {
  pixelsPerToken: number;
  maxTokens: number;
  minTokens?: number;
  noTokensAboveSide?: number;
}

const PNG_DATA_URL = /^data:image\/png;base64,(.*)$/s;
const PNG_HEADER_BYTES = 24;

const fakePngSize = (part: unknown): { width: number; height: number } | undefined => {
  if (!isRecord(part) || !isRecord(part['image_url'])) return undefined;
  const url = part['image_url']['url'];
  const payload = typeof url === 'string' ? PNG_DATA_URL.exec(url)?.[1] : undefined;
  if (payload === undefined) return undefined;
  const header = Buffer.from(payload.slice(0, 64), 'base64');
  return header.length < PNG_HEADER_BYTES ? undefined : { width: header.readUInt32BE(16), height: header.readUInt32BE(20) };
};

const fakeImageTokens = (part: unknown, model: FakeImageTokenModel): number => {
  if (!isRecord(part) || part['type'] !== 'image_url' || !isRecord(part['image_url'])) return 0;
  const size = fakePngSize(part);
  if (size === undefined) return model.maxTokens;
  if (model.noTokensAboveSide !== undefined && Math.max(size.width, size.height) > model.noTokensAboveSide) return 0;
  const linear = Math.ceil((size.width * size.height) / model.pixelsPerToken);
  return Math.max(model.minTokens ?? 0, Math.min(model.maxTokens, linear));
};

const withoutFakeImages = (value: unknown, model: FakeImageTokenModel | undefined): { value: unknown; imageTokens: number } => {
  let imageTokens = 0;
  const strip = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(strip);
    if (!isRecord(node)) return node;
    if (model !== undefined && node['type'] === 'image_url' && isRecord(node['image_url'])) {
      imageTokens += fakeImageTokens(node, model);
      return { type: node['type'] };
    }
    return Object.fromEntries(Object.entries(node).map(([key, child]) => [key, strip(child)]));
  };
  return { value: strip(value), imageTokens };
};

export const countFakeRequestTokens = (body: unknown, imageModel?: FakeImageTokenModel): number => {
  const messages = isRecord(body) ? body['messages'] : undefined;
  const tools = isRecord(body) ? body['tools'] : undefined;
  const { value, imageTokens } = withoutFakeImages([messages ?? [], tools ?? []], imageModel);
  return tokensForText(JSON.stringify(value)) + imageTokens;
};

export const fakeUsageOfRequest = (body: unknown, completionTokens: number, imageModel?: FakeImageTokenModel): FakeFixedUsage => {
  const promptTokens = countFakeRequestTokens(body, imageModel);
  return { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens };
};

const resolvedUsage = (usage: FakeFixedUsage | FakeUsageOfRequest, body: unknown): FakeFixedUsage => (typeof usage === 'function' ? usage(body) : usage);

export const isValidAtIndex = (index: number, rate: number): boolean => {
  const percent = Math.round(rate * 100);
  return Math.floor(((index + 1) * percent) / 100) > Math.floor((index * percent) / 100);
};

const findRequestedName = (text: string, candidates: readonly string[]): string | undefined => {
  let best: string | undefined;
  for (const candidate of candidates) {
    if (candidate.length > 0 && text.includes(candidate) && (best === undefined || candidate.length > best.length)) {
      best = candidate;
    }
  }
  return best;
};

const wrongTyped = (value: unknown): unknown => {
  if (typeof value === 'string') return 12345;
  if (typeof value === 'number') return 'not-a-number';
  if (typeof value === 'boolean') return 'not-a-boolean';
  if (Array.isArray(value)) return 'not-an-array';
  if (isRecord(value)) return 'not-an-object';
  return 'unexpected';
};

const mutateTypes = (value: unknown): unknown | undefined => {
  if (!isRecord(value) || Object.keys(value).length === 0) return undefined;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, wrongTyped(entry)]));
};

const TOOL_RESULT_PREFIX = '<tool_result';

const MALFORMED_JSON = '{"kind": "tool_calls", "calls": [{"name": ';

const readBody = async (request: http.IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
};

const createSocketPath = (): { socketPath: string; ownedDir?: string } => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-'));
  fs.chmodSync(dir, 0o700);
  return { socketPath: path.join(dir, 'fake.sock'), ownedDir: dir };
};

export const startFakeChatCompletions = async (
  options: FakeChatCompletionsOptions,
): Promise<FakeChatCompletionsServer> => {
  const contextWindow = options.contextWindow ?? 4096;
  const exposure = options.contextSizeExposure ?? 'none';
  const modelId = options.modelId ?? 'system';
  const maxConcurrency = options.maxConcurrency ?? 1;
  const overflow = options.overflow ?? 'reject';
  const latencyMs = options.latencyMs ?? 0;
  const failNativeSamples = options.failNativeSamples ?? [];
  let rateLimitedSizedImages = 0;
  const failConstrainedSamples = options.failConstrainedSamples ?? [];
  const stallNativeSamples = options.stallNativeSamples ?? [];
  const stallMs = options.stallMs ?? 2000;
  const nativeValidity = options.nativeValidity ?? 1;
  const constrainedValidity = options.constrainedValidity ?? 1;
  const unsupportedKeywords = options.unsupportedKeywords ?? [];
  const usageReported = options.usageReported ?? true;
  const toolsAccepted = options.scenario === 'tools-ok' || options.scenario === 'tools-ignored';
  const jsonSchemaAccepted = options.scenario !== 'none';

  const requests: RecordedRequest[] = [];
  const script = [...(options.script ?? [])];
  const routes = [...(options.routes ?? [])];
  const routeHits = routes.map(() => 0);
  let disconnectCount = 0;
  let inFlight = 0;
  const waiting: Array<() => void> = [];
  let completionCount = 0;
  let nativeIndex = 0;
  let nativeInvalidCount = 0;
  let constrainedIndex = 0;
  let constrainedInvalidCount = 0;
  type PendingHold = { arrived(request: RecordedRequest): void; released: Promise<void>; release(): void };
  const holds: PendingHold[] = [];
  const createdHolds: PendingHold[] = [];
  const createHold = (): FakeResponseHold => {
    let arrived: (request: RecordedRequest) => void = () => undefined;
    const request = new Promise<RecordedRequest>((resolve) => {
      arrived = resolve;
    });
    let release: () => void = () => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = { arrived, released, release };
    holds.push(pending);
    createdHolds.push(pending);
    return { waitForRequest: () => request, release };
  };

  const nativeCompletion = (body: Json, lastText: string): CompletionOut | undefined => {
    const tools = Array.isArray(body['tools']) ? body['tools'] : [];
    const functions = tools
      .map((tool: unknown) => (isRecord(tool) && isRecord(tool['function']) ? tool['function'] : undefined))
      .filter((fn): fn is Json => fn !== undefined && typeof fn['name'] === 'string');
    const name = findRequestedName(
      lastText,
      functions.map((fn) => fn['name'] as string),
    );
    if (name === undefined) return undefined;
    const fn = functions.find((candidate) => candidate['name'] === name);
    const args = generateInstance(fn?.['parameters'] ?? { type: 'object' });
    const sampleIndex = nativeIndex;
    nativeIndex += 1;
    if (failNativeSamples.includes(sampleIndex)) {
      throw new HttpFailure(400, structuredClone(FAKE_GUARDRAIL_ERROR) as unknown as Json);
    }
    const valid = isValidAtIndex(sampleIndex, nativeValidity);
    let serialized = JSON.stringify(args);
    if (!valid) {
      const mutated = nativeInvalidCount % 2 === 1 ? mutateTypes(args) : undefined;
      serialized = mutated === undefined ? '{"broken": ' : JSON.stringify(mutated);
      nativeInvalidCount += 1;
    }
    const callCount = options.parallelToolCalls === true && body['parallel_tool_calls'] === true ? 2 : 1;
    return {
      content: null,
      toolCalls: Array.from({ length: callCount }, (_, index) => ({
        id: `call_${completionCount}_${index}`,
        type: 'function' as const,
        function: { name, arguments: serialized },
      })),
      finishReason: 'tool_calls',
      ...(stallNativeSamples.includes(sampleIndex) ? { delayMs: stallMs } : {}),
    };
  };

  const constrainedCompletion = (schema: unknown, lastText: string, lastRole: unknown): CompletionOut => {
    const requiredToolName =
      lastRole === 'user' && !lastText.trimStart().startsWith(TOOL_RESULT_PREFIX) ? findRequestedName(lastText, collectAllowedNames(schema)) : undefined;
    if (requiredToolName === undefined) {
      return { content: JSON.stringify(generateInstance(schema)), toolCalls: [], finishReason: 'stop' };
    }
    const instance = generateInstance(schema, { requiredToolName });
    const sampleIndex = constrainedIndex;
    constrainedIndex += 1;
    if (failConstrainedSamples.includes(sampleIndex)) {
      throw new HttpFailure(400, structuredClone(FAKE_GUARDRAIL_ERROR) as unknown as Json);
    }
    const valid = isValidAtIndex(sampleIndex, constrainedValidity);
    if (valid) return { content: JSON.stringify(instance), toolCalls: [], finishReason: 'stop' };
    let content = MALFORMED_JSON;
    if (constrainedInvalidCount % 2 === 1 && isRecord(instance) && Array.isArray(instance['calls'])) {
      const call = instance['calls'][0];
      const mutated = isRecord(call) ? mutateTypes(call['arguments']) : undefined;
      if (mutated !== undefined && isRecord(call)) {
        content = JSON.stringify({ ...instance, calls: [{ ...call, arguments: mutated }] });
      }
    }
    constrainedInvalidCount += 1;
    return { content, toolCalls: [], finishReason: 'stop' };
  };

  const validateCompletionRequest = (body: Json): void => {
    const messages = Array.isArray(body['messages']) ? (body['messages'] as ChatMessage[]) : [];
    const responseFormat = isRecord(body['response_format']) ? body['response_format'] : undefined;
    if (responseFormat?.['type'] === 'json_object') throw invalidRequest(JSON_OBJECT_UNSUPPORTED_MESSAGE, null, 'response_format');
    if (body['stop'] !== undefined && body['stop'] !== null && options.stopSupported !== true) {
      throw invalidRequest(STOP_UNSUPPORTED_MESSAGE, null, 'stop');
    }
    const hasImage = messages.some(
      (message) =>
        Array.isArray(message.content) &&
        message.content.some((part: unknown) => isRecord(part) && part['type'] === 'image_url'),
    );
    if (hasImage && options.imageInput !== true) throw invalidRequest(IMAGE_UNSUPPORTED_MESSAGE, null, 'messages');
    if (options.imageSizeLimit !== undefined) {
      const { maxSide, status } = options.imageSizeLimit;
      const parts = messages.flatMap((message) => (Array.isArray(message.content) ? (message.content as unknown[]) : []));
      const oversized = parts.some((part) => {
        const size = fakePngSize(part);
        return size !== undefined && Math.max(size.width, size.height) > maxSide;
      });
      if (oversized) throw status === 413 ? new HttpFailure(413, structuredClone(FAKE_PAYLOAD_TOO_LARGE_ERROR) as unknown as Json) : invalidRequest('The image is too large.', null, 'messages');
    }
    if (options.rateLimitSizedImages !== undefined && rateLimitedSizedImages < options.rateLimitSizedImages.count) {
      const sized = messages
        .flatMap((message) => (Array.isArray(message.content) ? (message.content as unknown[]) : []))
        .some((part) => {
          const size = fakePngSize(part);
          return size !== undefined && Math.max(size.width, size.height) > 1;
        });
      if (sized) {
        rateLimitedSizedImages += 1;
        throw new HttpFailure(
          429,
          { error: { message: 'Too many requests.', type: 'rate_limit_error', param: null, code: 'rate_limit_exceeded' } },
          { 'retry-after': options.rateLimitSizedImages.retryAfter },
        );
      }
    }
    if (
      options.guardrailTrigger !== undefined &&
      messages.some((message) => messageText(message).includes(options.guardrailTrigger as string))
    ) {
      throw new HttpFailure(400, structuredClone(FAKE_GUARDRAIL_ERROR) as unknown as Json);
    }
    if (options.reasoning?.effort === 'rejected' && body['reasoning_effort'] !== undefined) {
      throw invalidRequest('Unrecognized request argument supplied: reasoning_effort', null, 'reasoning_effort');
    }
    if (Array.isArray(body['tools']) && body['tools'].length > 0 && !toolsAccepted) {
      throw invalidRequest(TOOLS_UNSUPPORTED_MESSAGE, null, 'tools');
    }
    if (responseFormat?.['type'] === 'json_schema') {
      if (!jsonSchemaAccepted) throw invalidRequest(JSON_SCHEMA_UNSUPPORTED_MESSAGE, null, 'response_format');
      const jsonSchema = isRecord(responseFormat['json_schema']) ? responseFormat['json_schema'] : {};
      const used = findUsedKeywords(jsonSchema['schema'], unsupportedKeywords);
      if (used.length > 0) {
        if (options.wire === 'fm') throw new FmStreamedError(FM_UNSUPPORTED_GUIDE_ERROR);
        throw invalidRequest(`Unsupported JSON Schema keyword: ${used.join(', ')}`, 'unsupported_schema', 'response_format');
      }
    }
    const maxTokens = body['max_tokens'] ?? body['max_completion_tokens'];
    const requested = countFakeRequestTokens(body, options.imageTokens) + (typeof maxTokens === 'number' ? maxTokens : 0);
    if (requested > contextWindow) {
      if (options.wire === 'fm') throw new FmStreamedError(FM_CONTEXT_OVERFLOW_ERROR);
      if (options.contextOverflowStatus === 500) {
        throw new HttpFailure(500, { error: { message: 'Internal server error.', type: 'server_error', param: null, code: null } });
      }
      if (options.contextOverflowStatus === 413) {
        throw new HttpFailure(413, structuredClone(FAKE_PAYLOAD_TOO_LARGE_ERROR) as unknown as Json);
      }
      throw invalidRequest(
        `This model's maximum context length is ${contextWindow} tokens. However, you requested ${requested} tokens.`,
        'context_length_exceeded',
        'messages',
      );
    }
  };

  const complete = (body: Json): CompletionOut => {
    const messages = Array.isArray(body['messages']) ? (body['messages'] as ChatMessage[]) : [];
    const last = messages.at(-1);
    const lastText = last === undefined ? '' : messageText(last);
    const lastRole = last?.role;
    const responseFormat = isRecord(body['response_format']) ? body['response_format'] : undefined;
    if (options.scenario === 'tools-ok' && Array.isArray(body['tools']) && lastRole === 'user') {
      const native = nativeCompletion(body, lastText);
      if (native !== undefined) return native;
    }
    if (responseFormat?.['type'] === 'json_schema') {
      const jsonSchema = isRecord(responseFormat['json_schema']) ? responseFormat['json_schema'] : {};
      return constrainedCompletion(jsonSchema['schema'], lastText, lastRole);
    }
    if (lastRole === 'tool') {
      return { content: `Tool result received: ${lastText}`, toolCalls: [], finishReason: 'stop' };
    }
    return { content: FAKE_DETERMINISTIC_REPLY, toolCalls: [], finishReason: 'stop' };
  };

  const usageFor = (body: Json, out: CompletionOut): Json => {
    const messages = Array.isArray(body['messages']) ? (body['messages'] as ChatMessage[]) : [];
    const promptTokens = countFakeRequestTokens(body, options.imageTokens);
    const completionText = out.content ?? out.toolCalls.map((call) => call.function.arguments).join(' ');
    const visibleTokens = Math.max(1, countFakeTokens(completionText));
    const reasoningTokens = reasoningTokensFor(body);
    const completionTokens = visibleTokens + reasoningTokens;
    return {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
      ...(options.reasoning === undefined || options.reasoning.reportsUsage === false ? {} : { completion_tokens_details: { reasoning_tokens: reasoningTokens } }),
    };
  };

  const REASONING_SHARE: Record<string, number> = { none: 0, minimal: 0.1, low: 0.25, medium: 0.5, high: 1, xhigh: 1 };

  const reasoningTokensFor = (body: Json): number => {
    const reasoning = options.reasoning;
    if (reasoning === undefined) return 0;
    const effort = body['reasoning_effort'];
    if (reasoning.effort !== 'honoured' || typeof effort !== 'string') return reasoning.tokens;
    return Math.round(reasoning.tokens * (REASONING_SHARE[effort] ?? 1));
  };

  const writeJson = (response: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void => {
    response.writeHead(status, { 'content-type': 'application/json', ...headers });
    response.end(JSON.stringify(body));
  };

  const writeStream = (response: http.ServerResponse, body: Json, out: CompletionOut, id: string): void => {
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const base = { id, object: 'chat.completion.chunk', created: 0, model: modelId };
    const send = (payload: unknown): void => {
      response.write(`data: ${JSON.stringify(payload)}\n\n`);
    };
    const chunk = (delta: Json, finishReason: string | null = null): void => {
      send({ ...base, choices: [{ index: 0, delta, finish_reason: finishReason }] });
    };
    chunk({ role: 'assistant', content: '' });
    if (out.content !== null) {
      const words = out.content.split(/(?<= )/);
      for (const word of words) chunk({ content: word });
    }
    out.toolCalls.forEach((call, index) => {
      const args = call.function.arguments;
      const middle = Math.max(1, Math.floor(args.length / 2));
      chunk({ tool_calls: [{ index, id: call.id, type: 'function', function: { name: call.function.name, arguments: args.slice(0, middle) } }] });
      chunk({ tool_calls: [{ index, function: { arguments: args.slice(middle) } }] });
    });
    chunk({}, out.finishReason);
    const streamOptions = isRecord(body['stream_options']) ? body['stream_options'] : {};
    if (options.wire === 'fm' || (streamOptions['include_usage'] === true && options.streamUsage === true)) {
      send({ ...base, choices: [], usage: usageFor(body, out) });
    }
    response.write('data: [DONE]\n\n');
    response.end();
  };

  const writeFmError = (response: http.ServerResponse, id: string, body: unknown): void => {
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const roleChunk = { id, object: 'chat.completion.chunk', created: 0, model: modelId, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] };
    response.write(`data: ${JSON.stringify(roleChunk)}\n\n`);
    response.write(`event: error\ndata: ${JSON.stringify(body)}\n\n`);
    response.end();
  };

  const writeScriptedChunks = (response: http.ServerResponse, chunks: readonly FakeStreamChunk[], id: string): void => {
    for (const chunk of chunks) {
      const payload = {
        id,
        object: 'chat.completion.chunk',
        created: 0,
        model: modelId,
        choices: [{ index: 0, delta: chunk.delta, finish_reason: chunk.finishReason ?? null }],
      };
      response.write(`data: ${JSON.stringify(payload)}\n\n`);
    }
  };

  const serveScripted = async (reply: FakeScriptedReply, response: http.ServerResponse, requestBody: unknown): Promise<void> => {
    if (reply.kind === 'error') {
      writeJson(response, reply.status, reply.body, reply.headers ?? {});
      return;
    }
    completionCount += 1;
    const id = `chatcmpl-fake-${completionCount}`;
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    if (reply.kind === 'hang') {
      writeScriptedChunks(response, reply.chunks ?? [], id);
      await new Promise<void>((resolve) => response.once('close', () => resolve()));
      return;
    }
    if (reply.kind === 'raw-sse') {
      for (const event of reply.events) response.write(`data: ${event}\n\n`);
      response.end();
      return;
    }
    writeScriptedChunks(response, reply.chunks, id);
    if (reply.usage !== undefined) {
      response.write(
        `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 0, model: modelId, choices: [], usage: resolvedUsage(reply.usage, requestBody) })}\n\n`,
      );
    }
    if (reply.done !== false) response.write('data: [DONE]\n\n');
    response.end();
  };

  const handleCompletion = async (body: Json, response: http.ServerResponse, signal: AbortSignal): Promise<void> => {
    validateCompletionRequest(body);
    if (latencyMs > 0) await delay(latencyMs, undefined, { signal });
    completionCount += 1;
    const out = complete(body);
    if (out.delayMs !== undefined) await delay(out.delayMs, undefined, { signal });
    const id = `chatcmpl-fake-${completionCount}`;
    if (body['stream'] === true || options.wire === 'fm') {
      writeStream(response, body, out, id);
      return;
    }
    const message: Json = { role: 'assistant', content: out.content };
    if (options.reasoning?.field !== undefined) message[options.reasoning.field] = FAKE_REASONING_WORD.repeat(reasoningTokensFor(body)).trimEnd();
    if (out.toolCalls.length > 0) message['tool_calls'] = out.toolCalls;
    const payload: Json = {
      id,
      object: 'chat.completion',
      created: 0,
      model: modelId,
      choices: [{ index: 0, message, finish_reason: out.finishReason }],
    };
    if (usageReported) payload['usage'] = usageFor(body, out);
    writeJson(response, 200, payload);
  };

  const server = http.createServer((request, response) => {
    void (async () => {
      const raw = await readBody(request);
      let body: unknown = undefined;
      if (raw.length > 0) {
        try {
          body = JSON.parse(raw);
        } catch {
          body = raw;
        }
      }
      const requestPath = request.url ?? '/';
      requests.push({ method: request.method ?? 'GET', path: requestPath, headers: request.headers, body });
      if (request.method === 'GET' && requestPath === '/health') {
        if (options.healthy === false) {
          writeJson(response, 503, { status: 'unavailable' });
          return;
        }
        if (exposure === 'health') writeJson(response, 200, { status: 'ok', context_window: contextWindow });
        else if (exposure === 'health-nested') {
          writeJson(response, 200, { status: 'ok', limits: { context_size: contextWindow } });
        } else writeJson(response, 200, { status: 'ok' });
        return;
      }
      if (request.method === 'GET' && requestPath === '/v1/models') {
        const reply = options.modelsReply;
        if (reply?.kind === 'error') {
          writeJson(response, reply.status, reply.body);
          return;
        }
        if (reply?.kind === 'hang') {
          response.once('close', () => {
            if (!response.writableFinished) disconnectCount += 1;
          });
          return;
        }
        const entry: Json = { id: modelId, object: 'model', created: 0, owned_by: 'system' };
        if (exposure === 'models') entry['context_window'] = contextWindow;
        if (exposure === 'models-nested') entry['metadata'] = { limits: { contextSize: contextWindow } };
        const listed = typeof options.models === 'function' ? options.models() : options.models;
        writeJson(response, 200, { object: 'list', data: listed ?? [entry] });
        return;
      }
      if (request.method === 'POST' && requestPath === '/v1/chat/completions') {
        response.once('close', () => {
          if (!response.writableFinished) disconnectCount += 1;
        });
        const routeIndex = routes.findIndex((route) => route.match(body));
        if (routeIndex >= 0) {
          routeHits[routeIndex] = (routeHits[routeIndex] as number) + 1;
          const { reply } = routes[routeIndex] as FakeRoute;
          await serveScripted(typeof reply === 'function' ? reply(body) : reply, response, body);
          return;
        }
        const held = holds.shift();
        if (held !== undefined) {
          held.arrived(requests[requests.length - 1] as RecordedRequest);
          await held.released;
          if (response.destroyed) return;
        }
        const scripted = script.shift();
        if (scripted !== undefined) {
          await serveScripted(scripted, response, body);
          return;
        }
        if (inFlight >= maxConcurrency && overflow === 'reject') {
          writeJson(
            response,
            429,
            { error: { message: 'Too many concurrent requests.', type: 'rate_limit_error', param: null, code: 'rate_limit_exceeded' } },
            { 'retry-after': '1' },
          );
          return;
        }
        const disconnected = new AbortController();
        let slotHeld = false;
        const releaseSlot = (): void => {
          if (!slotHeld) return;
          slotHeld = false;
          const next = waiting.shift();
          if (next === undefined) inFlight -= 1;
          else next();
        };
        response.once('close', () => {
          disconnected.abort();
          releaseSlot();
        });
        if (inFlight < maxConcurrency) {
          inFlight += 1;
        } else {
          await new Promise<void>((resolve) => waiting.push(resolve));
        }
        slotHeld = true;
        try {
          if (!isRecord(body)) throw invalidRequest('Request body must be a JSON object.');
          await handleCompletion(body, response, disconnected.signal);
        } catch (error) {
          if (disconnected.signal.aborted) return;
          if (error instanceof FmStreamedError) writeFmError(response, `chatcmpl-fake-${completionCount}`, error.body);
          else if (error instanceof HttpFailure) writeJson(response, error.status, error.body, error.headers);
          else writeJson(response, 500, { error: { message: String(error), type: 'server_error', param: null, code: null } });
        } finally {
          releaseSlot();
        }
        return;
      }
      writeJson(response, 404, { error: { message: 'Not found', type: 'invalid_request_error', param: null, code: null } });
    })();
  });

  const sockets = new Set<net.Socket>();
  server.on('connection', (socket: net.Socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });

  const { socketPath, ownedDir } =
    options.socketPath === undefined ? createSocketPath() : { socketPath: options.socketPath, ownedDir: undefined };
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.off('error', reject);
      resolve();
    });
  });

  let closed = false;
  return {
    socketPath,
    requests,
    routeHits,
    openConnections: () => sockets.size,
    disconnects: () => disconnectCount,
    hold: createHold,
    close: async () => {
      if (closed) return;
      closed = true;
      holds.length = 0;
      for (const pending of createdHolds) pending.release();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (ownedDir !== undefined) fs.rmSync(ownedDir, { recursive: true, force: true });
    },
  };
};
