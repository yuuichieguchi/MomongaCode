import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createAnthropicAdapter, createChatCompletionsAdapter, createOpenResponsesAdapter, UPSTREAM_LIVENESS_DEFAULTS } from '@momonga/gateway';
import type { UpstreamLiveness } from '@momonga/gateway';
import type { AdapterContext, AdapterRequest, Capabilities, ProviderAdapter, StreamEvent } from '@momonga/protocol';
import { anthropicMessageStart, createFakeClock, openingEvents } from '@momonga/testkit';
import { START_MS, registerCleanup } from './gateway-helpers.ts';
import { CC_CAPABILITIES } from './cc-support.ts';
import { contextOf } from './own-reasoning.ts';
import { REMOTE_CAPABILITIES } from './upstream-gateway-support.ts';

const IDLE_MS = 400;
const PING_EVERY_MS = 40;
const TEST_TIMEOUT_MS = 20_000;
const LIVENESS: UpstreamLiveness = { headersTimeoutMs: 5_000, idleTimeoutMs: IDLE_MS };
const IDLE_TEXT = `The model sent no output for ${IDLE_MS / 1000} s (only keep-alive signals arrived), so the call was stopped. Raise models.idleTimeoutMs if this model needs longer.`;
const REQUEST: AdapterRequest = { model: 'upstream-model', input: [{ type: 'message', role: 'user', content: 'hi' }] };

type Step = { waitMs: number; write: string } | { repeatEveryMs: number; write: string; untilMs: number };
type Script = { steps: Step[]; end: 'hang' | 'close' };

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const startTimedUpstream = async (script: Script): Promise<{ socketPath: string; bodies: unknown[] }> => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'momonga-idle-'));
  const socketPath = path.join(dir, 'upstream.sock');
  const bodies: unknown[] = [];
  const open = new Set<http.ServerResponse>();
  const server = http.createServer((request, response) => {
    let raw = '';
    request.on('data', (chunk: Buffer) => {
      raw += chunk.toString('utf8');
    });
    request.on('end', () => {
      bodies.push(raw === '' ? raw : JSON.parse(raw));
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.flushHeaders();
      open.add(response);
      void (async () => {
        for (const step of script.steps) {
          if ('waitMs' in step) {
            await sleep(step.waitMs);
            if (response.destroyed) return;
            response.write(step.write);
            continue;
          }
          const startedAt = Date.now();
          while (Date.now() - startedAt < step.untilMs) {
            await sleep(step.repeatEveryMs);
            if (response.destroyed) return;
            response.write(step.write);
          }
        }
        if (script.end === 'close') response.end();
      })();
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  registerCleanup(async () => {
    for (const response of open) response.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { socketPath, bodies };
};

const sse = (data: unknown, event?: string): string => `${event === undefined ? '' : `event: ${event}\n`}data: ${JSON.stringify(data)}\n\n`;

const chatChunk = (delta: Record<string, unknown>, finishReason: string | null = null): string =>
  sse({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta, finish_reason: finishReason }] });

type Ending = { kind: 'failed'; message: string; events: StreamEvent[] } | { kind: 'ended'; events: StreamEvent[] };

const drive = async (adapter: ProviderAdapter, ctx: AdapterContext, request: AdapterRequest = REQUEST): Promise<Ending> => {
  const events: StreamEvent[] = [];
  try {
    for await (const event of adapter.create(request, ctx)) events.push(event);
  } catch (error) {
    return { kind: 'failed', message: error instanceof Error ? error.message : String(error), events };
  }
  const last = events.at(-1);
  if (last?.type === 'response.failed') return { kind: 'failed', message: last.response.error.message, events };
  return { kind: 'ended', events };
};

const chatAdapter = (socketPath: string, capabilities: Capabilities = CC_CAPABILITIES) => {
  const adapter = createChatCompletionsAdapter({
    resolveEndpoint: async () => ({ kind: 'unix', socketPath }),
    capabilities: async () => capabilities,
    schemaDialect: () => capabilities.schemaDialect,
    clock: createFakeClock(START_MS),
    liveness: LIVENESS,
  });
  registerCleanup(() => adapter.close());
  return adapter;
};

const responsesAdapter = (socketPath: string, capabilities: Capabilities = REMOTE_CAPABILITIES) => {
  const adapter = createOpenResponsesAdapter({
    resolveEndpoint: async () => ({ kind: 'unix', socketPath }),
    capabilities: async () => capabilities,
    clock: createFakeClock(START_MS),
    liveness: LIVENESS,
  });
  registerCleanup(() => adapter.close());
  return adapter;
};

const target = { name: 'remote', model: 'upstream-model' };

describe('G1: the upstream idle bound restarts only when content arrives (audit-unbounded-waits-2026-11-07.md, R-G1a)', () => {
  it('keeps one default for models.idleTimeoutMs, 300 s', () => {
    expect(UPSTREAM_LIVENESS_DEFAULTS.idleTimeoutMs).toBe(300_000);
  });

  it(
    'test 1: ends an Anthropic stream that sends only ping events past models.idleTimeoutMs with the idle text',
    async () => {
      const upstream = await startTimedUpstream({
        steps: [
          { waitMs: 1, write: sse(anthropicMessageStart().data, 'message_start') },
          { repeatEveryMs: PING_EVERY_MS, write: sse({ type: 'ping' }, 'ping'), untilMs: IDLE_MS * 10 },
        ],
        end: 'hang',
      });
      const adapter = createAnthropicAdapter({
        resolveEndpoint: async () => ({ kind: 'unix', socketPath: upstream.socketPath }),
        apiKey: async () => 'sk-test-key',
        capabilities: async () => REMOTE_CAPABILITIES,
        clock: createFakeClock(START_MS),
        apiVersion: '2026-10-21',
        liveness: LIVENESS,
      });
      registerCleanup(() => adapter.close());
      const startedAt = Date.now();
      const ending = await drive(adapter, await contextOf(adapter, target));
      expect(ending).toMatchObject({ kind: 'failed', message: IDLE_TEXT });
      expect(Date.now() - startedAt).toBeLessThan(IDLE_MS * 5);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'test 2: ends a Chat Completions stream of comment-only SSE pings with the idle text',
    async () => {
      const upstream = await startTimedUpstream({ steps: [{ repeatEveryMs: PING_EVERY_MS, write: ':\n\n', untilMs: IDLE_MS * 10 }], end: 'hang' });
      const adapter = chatAdapter(upstream.socketPath);
      const startedAt = Date.now();
      const ending = await drive(adapter, await contextOf(adapter, target));
      expect(ending).toMatchObject({ kind: 'failed', message: IDLE_TEXT });
      expect(Date.now() - startedAt).toBeLessThan(IDLE_MS * 5);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'test 3: ends an Open Responses stream that repeats response.in_progress with the idle text',
    async () => {
      const [created, inProgress] = openingEvents();
      const upstream = await startTimedUpstream({
        steps: [
          { waitMs: 1, write: sse({ ...created, sequence_number: 0 }, 'response.created') },
          { repeatEveryMs: PING_EVERY_MS, write: sse({ ...inProgress, sequence_number: 1 }, 'response.in_progress'), untilMs: IDLE_MS * 10 },
        ],
        end: 'hang',
      });
      const adapter = responsesAdapter(upstream.socketPath);
      const startedAt = Date.now();
      const ending = await drive(adapter, await contextOf(adapter, target));
      expect(ending).toMatchObject({ kind: 'failed', message: IDLE_TEXT });
      expect(Date.now() - startedAt).toBeLessThan(IDLE_MS * 5);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'test 4: one content delta restarts the bound once, then pings alone end the call',
    async () => {
      const upstream = await startTimedUpstream({
        steps: [
          { waitMs: IDLE_MS / 2, write: chatChunk({ role: 'assistant', content: 'partial' }) },
          { repeatEveryMs: PING_EVERY_MS, write: ':\n\n', untilMs: IDLE_MS * 10 },
        ],
        end: 'hang',
      });
      const adapter = chatAdapter(upstream.socketPath);
      const startedAt = Date.now();
      const ending = await drive(adapter, await contextOf(adapter, target));
      const elapsed = Date.now() - startedAt;
      expect(ending).toMatchObject({ kind: 'failed', message: IDLE_TEXT });
      expect(ending.events.some((event) => event.type === 'response.output_text.delta')).toBe(true);
      expect(elapsed).toBeGreaterThanOrEqual(IDLE_MS / 2 + IDLE_MS - PING_EVERY_MS);
      expect(elapsed).toBeLessThan(IDLE_MS * 5);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'test 5: a llama.cpp prompt_progress chunk every idle/2 is content, so a server that reads a long prompt is not cut',
    async () => {
      const progress = sse({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta: {}, finish_reason: null }], prompt_progress: { total: 100, cache: 0, processed: 10, time_ms: 5 } });
      const upstream = await startTimedUpstream({
        steps: [
          { repeatEveryMs: IDLE_MS / 2, write: progress, untilMs: IDLE_MS * 4 },
          { waitMs: 1, write: chatChunk({ role: 'assistant', content: 'done' }) },
          { waitMs: 1, write: chatChunk({}, 'stop') },
          { waitMs: 1, write: 'data: [DONE]\n\n' },
        ],
        end: 'close',
      });
      const adapter = chatAdapter(upstream.socketPath);
      const ending = await drive(adapter, await contextOf(adapter, target));
      expect(ending.kind).toBe('ended');
      expect(ending.events.at(-1)?.type).toBe('response.completed');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'test 6: compact with a ping-only stream ends in the same way (R-G1c)',
    async () => {
      const upstream = await startTimedUpstream({ steps: [{ repeatEveryMs: PING_EVERY_MS, write: ':\n\n', untilMs: IDLE_MS * 10 }], end: 'hang' });
      const adapter = chatAdapter(upstream.socketPath);
      const compact = adapter.compact;
      if (compact === undefined) throw new Error('the chat completions adapter compacts');
      const startedAt = Date.now();
      const failure = await compact.call(adapter, { model: 'upstream-model', input: REQUEST.input }, await contextOf(adapter, target)).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toBe(IDLE_TEXT);
      expect(Date.now() - startedAt).toBeLessThan(IDLE_MS * 5);
    },
    TEST_TIMEOUT_MS,
  );
});

describe('G1: a target that carries no output bound is ended at its bound by the gateway, as a length stop', () => {
  const CEILING = 16;
  const longDelta = 'word '.repeat(40);

  it(
    'counts the streamed Chat Completions output and ends the response at the declared maxOutputTokens as incomplete with reason max_output_tokens, not as a failure',
    async () => {
      const upstream = await startTimedUpstream({
        steps: [
          { waitMs: 1, write: chatChunk({ role: 'assistant', content: longDelta }) },
          { repeatEveryMs: 20, write: chatChunk({ content: longDelta }), untilMs: IDLE_MS * 10 },
        ],
        end: 'hang',
      });
      const adapter = chatAdapter(upstream.socketPath, { ...CC_CAPABILITIES, outputBoundField: 'none', maxOutputTokens: CEILING });
      const ending = await drive(adapter, await contextOf(adapter, target), { ...REQUEST, max_output_tokens: CEILING });
      expect(ending.kind).toBe('ended');
      const last = ending.events.at(-1);
      expect(last?.type).toBe('response.incomplete');
      expect(last?.type === 'response.incomplete' ? last.response.incomplete_details : undefined).toEqual({ reason: 'max_output_tokens' });
      const body = upstream.bodies[0] as Record<string, unknown>;
      expect(body['max_tokens']).toBeUndefined();
      expect(body['max_completion_tokens']).toBeUndefined();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'ends at the declared maxOutputTokens, not at a smaller requested bound: the declared value is the ceiling the context budget reserves (config/src/models.ts)',
    async () => {
      const upstream = await startTimedUpstream({
        steps: [
          { waitMs: 1, write: chatChunk({ role: 'assistant', content: longDelta }) },
          { waitMs: 1, write: chatChunk({}, 'stop') },
          { waitMs: 1, write: 'data: [DONE]\n\n' },
        ],
        end: 'close',
      });
      const adapter = chatAdapter(upstream.socketPath, { ...CC_CAPABILITIES, outputBoundField: 'none', maxOutputTokens: 1024 });
      const ending = await drive(adapter, await contextOf(adapter, target), { ...REQUEST, max_output_tokens: CEILING });
      expect(ending.events.at(-1)?.type).toBe('response.completed');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'ends at the declared maxOutputTokens when the request carries no bound',
    async () => {
      const upstream = await startTimedUpstream({
        steps: [{ repeatEveryMs: 10, write: chatChunk({ content: longDelta }), untilMs: IDLE_MS * 10 }],
        end: 'hang',
      });
      const adapter = chatAdapter(upstream.socketPath, { ...CC_CAPABILITIES, outputBoundField: 'none', maxOutputTokens: CEILING });
      const ending = await drive(adapter, await contextOf(adapter, target));
      const last = ending.events.at(-1);
      expect(last?.type === 'response.incomplete' ? last.response.incomplete_details : undefined).toEqual({ reason: 'max_output_tokens' });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'leaves a target that carries its bound to the model: no gateway cut below the requested bound',
    async () => {
      const upstream = await startTimedUpstream({
        steps: [
          { waitMs: 1, write: chatChunk({ role: 'assistant', content: longDelta }) },
          { waitMs: 1, write: chatChunk({}, 'stop') },
          { waitMs: 1, write: 'data: [DONE]\n\n' },
        ],
        end: 'close',
      });
      const adapter = chatAdapter(upstream.socketPath);
      const ending = await drive(adapter, await contextOf(adapter, target), { ...REQUEST, max_output_tokens: CEILING });
      expect(ending.events.at(-1)?.type).toBe('response.completed');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'does not forward max_output_tokens to an Open Responses target whose outputBoundField is none, and ends it at the bound',
    async () => {
      const [created, inProgress] = openingEvents();
      const delta = (index: number) => ({ type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: longDelta, sequence_number: index });
      const upstream = await startTimedUpstream({
        steps: [
          { waitMs: 1, write: sse({ ...created, sequence_number: 0 }, 'response.created') },
          { waitMs: 1, write: sse({ ...inProgress, sequence_number: 1 }, 'response.in_progress') },
          { waitMs: 1, write: sse({ type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg_1', status: 'in_progress', role: 'assistant', content: [] }, sequence_number: 2 }) },
          { waitMs: 1, write: sse({ type: 'response.content_part.added', item_id: 'msg_1', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] }, sequence_number: 3 }) },
          { repeatEveryMs: 10, write: sse(delta(4)), untilMs: IDLE_MS * 10 },
        ],
        end: 'hang',
      });
      const adapter = responsesAdapter(upstream.socketPath, { ...REMOTE_CAPABILITIES, outputBoundField: 'none', maxOutputTokens: CEILING });
      const ending = await drive(adapter, await contextOf(adapter, target), { ...REQUEST, max_output_tokens: CEILING });
      const body = upstream.bodies[0] as Record<string, unknown>;
      expect(body['max_output_tokens']).toBeUndefined();
      const last = ending.events.at(-1);
      expect(last?.type === 'response.incomplete' ? last.response.incomplete_details : undefined).toEqual({ reason: 'max_output_tokens' });
    },
    TEST_TIMEOUT_MS,
  );
});
