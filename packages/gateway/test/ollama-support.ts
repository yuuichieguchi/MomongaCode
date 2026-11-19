import { contextOf } from './own-reasoning.ts';
import fs from 'node:fs';
import type http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOllamaAdapter } from '@momonga/gateway';
import type { OllamaAdapterOptions } from '@momonga/gateway';
import type { AdapterRequest, AdapterTarget, Capabilities, ProviderAdapter, StreamEvent } from '@momonga/protocol';
import { createFakeClock, readBody, sendJson, startLoopbackServer } from '@momonga/testkit';
import { START_MS, registerCleanup } from './gateway-helpers.ts';
import { UNCONFIGURED_NETWORK } from '@momonga/testkit';
import { UNDICI_DEFAULT_LIVENESS } from '@momonga/testkit';

const FIXTURE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'ollama');

export const fixtureText = (name: string): string => fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8');

export const fixtureJson = (name: string): any => JSON.parse(fixtureText(name));

export const fixtureLines = (name: string): string[] => fixtureText(name).split('\n').filter((line) => line !== '');

export const SHORT_TOOL_CALL = 'short-tool-call.ndjson';
export const LONG_TEXT_THEN_TOOL_CALL = 'long-text-then-tool-call.ndjson';
export const QWEN_NATIVE_THINKING = 'qwen-native-thinking.ndjson';
export const OLLAMA_MODEL = 'devstral-small-2';
export const OLLAMA_LISTED = `${OLLAMA_MODEL}:latest`;
export const TRAINED_CONTEXT_LENGTH = 393216;
export const RECORDED_SERVER_VERSION = '0.40.13';

export const QWEN_MODEL = 'qwen3.8:27b';
export const RECORDED_TAGS = fixtureJson('tags.json');
const recordedDigestOf = (name: string): string => RECORDED_TAGS.models.find((entry: { name: string }) => entry.name === name).digest;
export const DEVSTRAL_DIGEST = recordedDigestOf(`${OLLAMA_MODEL}:latest`);
export const QWEN_DIGEST = recordedDigestOf(QWEN_MODEL);
export const tagsWithDevstralDigest = (digest: string) => ({
  models: RECORDED_TAGS.models.map((entry: { name: string }) => (entry.name === `${OLLAMA_MODEL}:latest` ? { ...entry, digest } : entry)),
});

export const MODEL_NOT_FOUND = { status: 404, body: { error: "model 'no-such-model' not found" } };
export const CONTEXT_OVERFLOW = { status: 400, body: { error: 'request (2559 tokens) exceeds the available context size (2048 tokens), try increasing it' } };
export const THINKING_UNSUPPORTED = { status: 400, body: { error: '"devstral-small-2" does not support thinking' } };

export type OllamaChatReply =
  | { kind: 'ndjson'; lines: readonly string[] }
  | { kind: 'error'; status: number; body: unknown }
  | { kind: 'hang'; lines: readonly string[] };

export type RecordedOllamaRequest = { method: string; path: string; headers: http.IncomingHttpHeaders; body: any };

export type FakeOllamaOptions = {
  chat?: OllamaChatReply[];
  version?: { status: number; body: unknown };
  show?: unknown;
  showStatus?: () => number;
  tags?: () => unknown;
  completions?: readonly string[];
  cacheProbe?: 'automatic' | 'none' | 'unreported' | 'malformed';
  jsonModeProbe?: 'accepts' | 'rejects' | 'ignores' | 'fails';
};

export type FakeOllama = {
  origin: string;
  requests: RecordedOllamaRequest[];
  chatBodies(): any[];
  closedChats(): number;
  close(): Promise<void>;
};

const isNonStreamingChat = (body: unknown): boolean => typeof body === 'object' && body !== null && (body as { stream?: unknown }).stream === false;

const IMAGE_PROBE_PROMPT = 'Describe this image.';

const isImageProbeChat = (body: unknown): boolean => isNonStreamingChat(body) && JSON.stringify(body).includes(IMAGE_PROBE_PROMPT);

const isProbeChat = (body: unknown): boolean => isNonStreamingChat(body) && !isImageProbeChat(body);

const PIXELS_PER_IMAGE_TOKEN = 750;
const MAX_IMAGE_TOKENS = 1600;
const IMAGE_PROBE_BASE_TOKENS = 20;

const imageTokensOf = (base64: string): number => {
  const png = Buffer.from(base64, 'base64');
  const pixels = png.readUInt32BE(16) * png.readUInt32BE(20);
  return Math.min(MAX_IMAGE_TOKENS, Math.max(1, Math.ceil(pixels / PIXELS_PER_IMAGE_TOKEN)));
};

const imageProbeTokens = (body: unknown): number => {
  const messages = (body as { messages: Array<{ images?: string[] }> }).messages;
  return IMAGE_PROBE_BASE_TOKENS + messages.flatMap((message) => message.images ?? []).reduce((sum, image) => sum + imageTokensOf(image), 0);
};

const writeLine = (response: http.ServerResponse, line: string): Promise<void> =>
  new Promise((resolve, reject) => {
    response.write(`${line}\n`, (error) => (error === null || error === undefined ? resolve() : reject(error)));
  });

const parsedBody = (text: string): unknown => {
  if (text === '') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

export const textCompletionSse = (text: string): string[] => [
  JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] }),
  JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
  JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } }),
];

export const startFakeOllama = async (options: FakeOllamaOptions = {}): Promise<FakeOllama> => {
  const requests: RecordedOllamaRequest[] = [];
  const script = [...(options.chat ?? [])];
  let closedChats = 0;
  const server = await startLoopbackServer(async (req, res) => {
    const body = parsedBody(await readBody(req));
    const url = new URL(req.url ?? '/', 'http://fake');
    requests.push({ method: req.method ?? '', path: url.pathname, headers: req.headers, body });
    if (url.pathname === '/api/version' && req.method === 'GET') {
      const version = options.version ?? { status: 200, body: fixtureJson('version.json') };
      sendJson(res, version.status, version.body);
      return;
    }
    if (url.pathname === '/api/show' && req.method === 'POST') {
      const status = options.showStatus?.() ?? 200;
      sendJson(res, status, status === 200 ? (options.show ?? fixtureJson('api-show.json')) : { error: 'the fake Ollama answers this read with an error' });
      return;
    }
    if (url.pathname === '/api/tags' && req.method === 'GET') {
      sendJson(res, 200, options.tags?.() ?? RECORDED_TAGS);
      return;
    }
    if (url.pathname.endsWith('/chat/completions') && req.method === 'POST') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const data of options.completions ?? textCompletionSse('configured path')) res.write(`data: ${data}\n\n`);
      res.end('data: [DONE]\n\n');
      return;
    }
    if (url.pathname === '/api/chat' && req.method === 'POST' && (body as { format?: unknown } | undefined)?.format === 'json' && options.jsonModeProbe !== undefined) {
      const behaviour = options.jsonModeProbe;
      if (behaviour === 'rejects') return sendJson(res, 400, { error: 'invalid format: json is not supported' });
      if (behaviour === 'fails') return sendJson(res, 500, { error: 'internal error' });
      const content = behaviour === 'accepts' ? '{"ok":true}' : 'Sure, here is the answer.';
      return sendJson(res, 200, JSON.parse(chunkLine({ content }, true, { done_reason: 'stop', prompt_eval_count: 40, prompt_eval_cached_count: 0, eval_count: 9 })));
    }
    if (url.pathname === '/api/chat' && req.method === 'POST' && isImageProbeChat(body)) {
      const { prompt_eval_cached_count: _omitted, ...withoutCached } = JSON.parse(doneLine());
      sendJson(res, 200, { ...withoutCached, prompt_eval_count: imageProbeTokens(body) });
      return;
    }
    if (url.pathname === '/api/chat' && req.method === 'POST' && isProbeChat(body)) {
      const repeated = requests.filter((request) => request.path === '/api/chat' && isProbeChat(request.body)).length > 1;
      const behaviour = options.cacheProbe ?? 'none';
      const { prompt_eval_cached_count: _omitted, ...withoutCached } = JSON.parse(doneLine());
      if (behaviour === 'malformed') {
        sendJson(res, 200, { ...withoutCached, prompt_eval_cached_count: 'many' });
        return;
      }
      sendJson(res, 200, behaviour === 'unreported' ? withoutCached : { ...withoutCached, prompt_eval_cached_count: behaviour === 'automatic' && repeated ? 1500 : 0 });
      return;
    }
    if (url.pathname === '/api/chat' && req.method === 'POST') {
      res.on('close', () => {
        closedChats += 1;
      });
      const reply = script.shift();
      if (reply === undefined) {
        sendJson(res, 500, { error: 'the fake Ollama has no scripted reply left' });
        return;
      }
      if (reply.kind === 'error') {
        sendJson(res, reply.status, reply.body);
        return;
      }
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      for (const line of reply.lines) await writeLine(res, line);
      if (reply.kind === 'hang') {
        await new Promise<void>((resolve) => res.once('close', () => resolve()));
        return;
      }
      res.end();
      return;
    }
    sendJson(res, 404, { error: '404 page not found' });
  });
  registerCleanup(() => server.close());
  return {
    origin: server.origin,
    requests,
    chatBodies: () => requests.filter((request) => request.path === '/api/chat' && !isImageProbeChat(request.body)).map((request) => request.body),
    closedChats: () => closedChats,
    close: () => server.close(),
  };
};

export const OLLAMA_TARGET: AdapterTarget = { name: 'local', display: 'local', model: OLLAMA_MODEL };

export const OLLAMA_CAPABILITIES: Capabilities = {
  contextWindow: 12288,
  maxOutputTokens: 2048,
  toolCalling: 'native',
  structuredOutput: 'json_schema',
  streaming: true,
  stopSequences: false,
  imageInput: true,
  imageTokens: { pixelsPerToken: 750, maxTokens: 1600, minTokens: 1 },
  parallelToolCalls: true,
  schemaDialect: 'json-schema-2020-12',
  tokenCounting: 'exact',
  usageReported: true,
  maxConcurrency: 1,
  source: 'config',
};

export const makeOllamaAdapter = (fake: FakeOllama, overrides: Partial<OllamaAdapterOptions> = {}): ProviderAdapter => {
  const adapter = createOllamaAdapter({ liveness: UNDICI_DEFAULT_LIVENESS,
    resolveEndpoint: async () => ({ kind: 'tcp', baseUrl: fake.origin, network: UNCONFIGURED_NETWORK }),
    capabilities: async () => OLLAMA_CAPABILITIES,
    statedWindow: OLLAMA_CAPABILITIES.contextWindow,
    clock: createFakeClock(START_MS),
    ...overrides,
  });
  registerCleanup(() => adapter.close?.());
  return adapter;
};

export type Collected = { events: StreamEvent[]; error: unknown };

export const collectOllama = async (
  adapter: ProviderAdapter,
  request: AdapterRequest,
  signal: AbortSignal = new AbortController().signal,
): Promise<Collected> => {
  const events: StreamEvent[] = [];
  try {
    for await (const event of adapter.create(request, await contextOf(adapter, OLLAMA_TARGET, signal))) events.push(event);
  } catch (error) {
    return { events, error };
  }
  return { events, error: undefined };
};

export const chunkLine = (message: Record<string, unknown>, done = false, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ model: OLLAMA_MODEL, created_at: '2026-11-04T11:55:09.646823Z', message: { role: 'assistant', content: '', ...message }, done, ...extra });

export const doneLine = (extra: Record<string, unknown> = {}): string =>
  chunkLine({}, true, { done_reason: 'stop', prompt_eval_count: 40, prompt_eval_cached_count: 0, eval_count: 9, ...extra });

export const withoutField = (line: string, field: string): string => {
  const parsed = JSON.parse(line) as Record<string, unknown>;
  delete parsed[field];
  return JSON.stringify(parsed);
};

export const usageFromCounts = (input: number, output: number, cached: number) => ({
  input_tokens: input,
  output_tokens: output,
  total_tokens: input + output,
  input_tokens_details: { cached_tokens: cached },
  output_tokens_details: { reasoning_tokens: 0 },
});

export const seededRandom = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
};
