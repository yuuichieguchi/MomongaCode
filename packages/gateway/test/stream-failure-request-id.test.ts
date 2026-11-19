import http from 'node:http';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createAnthropicAdapter, createChatCompletionsAdapter, createOllamaAdapter, createOpenResponsesAdapter, keyAuthSource, unauthenticatedSource } from '@momonga/gateway';
import type { AdapterTarget, ClassifiedError, ProviderAdapter, StreamEvent } from '@momonga/protocol';
import { TEST_FENCE, UNDICI_DEFAULT_LIVENESS, createFakeClock } from '@momonga/testkit';
import { GuardedAdapterError, guardAdapter } from '../src/core/guarded-adapter.ts';
import { createRedactor } from '../src/core/redaction.ts';
import { StreamFailure } from '../src/core/stream-failure.ts';
import { UpstreamHttpError, UpstreamProtocolError } from '../src/adapters/shared/failures.ts';
import { START_MS, makeDir, registerCleanup } from './gateway-helpers.ts';
import { OLLAMA_CAPABILITIES } from './ollama-support.ts';
import { EVERY_REASONING_IS_OWN, REASONING_ORIGIN_CODEC } from './own-reasoning.ts';
import { REMOTE_CAPABILITIES } from './upstream-gateway-support.ts';

const REQUEST_ID = 'req_stream_77';
const TARGET: AdapterTarget = { name: 'remote', display: 'remote', model: 'remote-model' };
const REQUEST = { model: 'remote-model', fence: TEST_FENCE, input: [{ type: 'message' as const, role: 'user' as const, content: 'hi' }], max_output_tokens: 300 };

type Reply = { contentType: string; body: string };

const serve = async (reply: Reply): Promise<string> => {
  const dir = makeDir();
  const socketPath = path.join(dir, 's.sock');
  const server = http.createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      response.writeHead(200, { 'content-type': reply.contentType, 'x-request-id': REQUEST_ID });
      response.end(reply.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  registerCleanup(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return socketPath;
};

const sse = (frames: readonly { event?: string; data: unknown }[]): Reply => ({
  contentType: 'text/event-stream',
  body: frames.map((frame) => `${frame.event === undefined ? '' : `event: ${frame.event}\n`}data: ${typeof frame.data === 'string' ? frame.data : JSON.stringify(frame.data)}\n\n`).join(''),
});

const ndjson = (lines: readonly unknown[]): Reply => ({ contentType: 'application/x-ndjson', body: lines.map((line) => `${JSON.stringify(line)}\n`).join('') });

type AdapterKind = 'chat-completions' | 'ollama' | 'anthropic' | 'open-responses';

const adapterFor = (kind: AdapterKind, socketPath: string): ProviderAdapter => {
  const shared = { resolveEndpoint: async () => ({ kind: 'unix' as const, socketPath }), clock: createFakeClock(START_MS), liveness: UNDICI_DEFAULT_LIVENESS };
  const adapter: ProviderAdapter =
    kind === 'chat-completions'
      ? createChatCompletionsAdapter({ ...shared, capabilities: async () => REMOTE_CAPABILITIES, schemaDialect: () => REMOTE_CAPABILITIES.schemaDialect, authSource: unauthenticatedSource })
      : kind === 'ollama'
        ? createOllamaAdapter({ ...shared, capabilities: async () => OLLAMA_CAPABILITIES, statedWindow: OLLAMA_CAPABILITIES.contextWindow })
        : kind === 'anthropic'
          ? createAnthropicAdapter({ ...shared, capabilities: async () => REMOTE_CAPABILITIES, apiVersion: '2026-10-21', authSource: keyAuthSource(async () => 'test-key') })
          : createOpenResponsesAdapter({ ...shared, capabilities: async () => REMOTE_CAPABILITIES, authSource: unauthenticatedSource });
  registerCleanup(() => adapter.close?.());
  return adapter;
};

type Run = { events: StreamEvent[]; thrown: unknown; seen: unknown[]; guarded: ProviderAdapter };

const run = async (kind: AdapterKind, reply: Reply | 'refused'): Promise<Run> => {
  const socketPath = reply === 'refused' ? path.join(makeDir(), 'absent.sock') : await serve(reply);
  const inner = adapterFor(kind, socketPath);
  const seen: unknown[] = [];
  const guarded = guardAdapter({ ...inner, classify: (error) => { seen.push(error); return inner.classify(error); } }, createRedactor({ credentials: [] }), REASONING_ORIGIN_CODEC);
  const events: StreamEvent[] = [];
  const ctx = { signal: new AbortController().signal, target: TARGET, attempt: 1, reasoningOrigin: EVERY_REASONING_IS_OWN, capabilities: await inner.capabilities(TARGET) };
  try {
    for await (const event of guarded.create(REQUEST, ctx)) events.push(event);
  } catch (thrown) {
    return { events, thrown, seen, guarded };
  }
  return { events, thrown: undefined, seen, guarded };
};

const thrownClassified = (outcome: Run): ClassifiedError => {
  if (!(outcome.thrown instanceof GuardedAdapterError)) throw new Error(`the stream did not throw a classified failure: ${String(outcome.thrown)}`);
  return outcome.thrown.classified;
};

const emittedClassified = (outcome: Run): { classified: ClassifiedError; requestIds: unknown } => {
  const failed = outcome.events.at(-1);
  if (failed?.type !== 'response.failed') throw new Error(`the stream ended with ${JSON.stringify(failed)} (${String(outcome.thrown)})`);
  const { error } = failed.response;
  return { classified: outcome.guarded.classify(new StreamFailure(error.code, error.type ?? 'server_error', error.message, error.requestIds)), requestIds: error.requestIds };
};

const ANTHROPIC_START = { event: 'message_start', data: { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'remote-model', content: [], stop_reason: null, usage: { input_tokens: 3, output_tokens: 1 } } } };
const OPEN_RESPONSES_CREATED = { data: { type: 'response.created', response: { id: 'resp_1', object: 'response', status: 'in_progress', model: 'remote-model', output: [] } } };
const CHAT_CHUNK = { data: { id: 'c1', object: 'chat.completion.chunk', model: 'remote-model', choices: [{ index: 0, delta: { role: 'assistant', content: 'partial' }, finish_reason: null }] } };

const THROWN: readonly { kind: AdapterKind; reply: Reply; errorClass: abstract new (...args: never[]) => Error; code: string }[] = [
  { kind: 'chat-completions', reply: sse([{ event: 'error', data: { error: { code: 'guardrail_violation', message: 'the reply was blocked' } } }]), errorClass: StreamFailure, code: 'guardrail_violation' },
  { kind: 'ollama', reply: ndjson([]), errorClass: StreamFailure, code: 'empty_upstream_stream' },
  { kind: 'anthropic', reply: sse([{ event: 'error', data: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } } }]), errorClass: UpstreamHttpError, code: 'overloaded_error' },
  { kind: 'open-responses', reply: sse([{ event: 'error', data: { type: 'error', code: 'server_is_overloaded', message: 'the server is busy' } }]), errorClass: StreamFailure, code: 'server_is_overloaded' },
];

const EMITTED: readonly { kind: AdapterKind; reply: Reply }[] = [
  { kind: 'chat-completions', reply: sse([CHAT_CHUNK, { event: 'error', data: { error: { code: 'server_error', message: 'the server broke' } } }]) },
  { kind: 'ollama', reply: ndjson([{ model: 'remote-model', message: { role: 'assistant', content: 'partial' }, done: false }, { error: 'the runner crashed' }]) },
  { kind: 'anthropic', reply: sse([ANTHROPIC_START, { event: 'error', data: { type: 'error', error: { type: 'some_new_error', message: 'odd' } } }]) },
  { kind: 'open-responses', reply: sse([OPEN_RESPONSES_CREATED, { data: { type: 'response.failed', response: { id: 'resp_1', status: 'failed', output: [], error: { code: 'server_error', message: 'the server broke' } } } }]) },
];

describe('a failure a streamed response throws carries the request id of that response', () => {
  it.each(THROWN)('$kind: the classified message names the request id, the failure keeps its class and code', async ({ kind, reply, errorClass, code }) => {
    const outcome = await run(kind, reply);
    const classified = thrownClassified(outcome);
    expect(classified.error.message).toMatch(new RegExp(`\\. Request id: ${REQUEST_ID}$`));
    expect(classified.error.code).toBe(code);
    expect(classified.error).not.toHaveProperty('requestIds');
    expect(outcome.seen[0]).toBeInstanceOf(errorClass);
    expect(outcome.seen[0]).toMatchObject(errorClass === UpstreamHttpError ? { upstreamCode: code } : { code });
  });
});

describe('a failure a streamed response emits carries the request id of that response', () => {
  it.each(EMITTED)('$kind: the failed event carries the ids and its classified message names the request id', async ({ kind, reply }) => {
    const { classified, requestIds } = emittedClassified(await run(kind, reply));
    expect(requestIds).toEqual({ 'x-request-id': REQUEST_ID });
    expect(classified.error.message).toMatch(new RegExp(`\\. Request id: ${REQUEST_ID}$`));
    expect(classified.error).not.toHaveProperty('requestIds');
  });
});

describe('a failure with no response carries no request id', () => {
  it('names no request id when the connection is refused', async () => {
    const classified = thrownClassified(await run('ollama', 'refused'));
    expect(classified.error.code).toBe('provider_unavailable');
    expect(classified.error.message).not.toMatch(/Request id/);
  });
});

describe('a protocol failure thrown after the response carries its request id', () => {
  it('composes the id into an upstream protocol error', async () => {
    const outcome = await run('anthropic', sse([{ event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x' } } }]));
    expect(outcome.seen[0]).toBeInstanceOf(UpstreamProtocolError);
    expect(thrownClassified(outcome).error.message).toMatch(new RegExp(`\\. Request id: ${REQUEST_ID}$`));
  });
});
