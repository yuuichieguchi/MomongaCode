import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace';
import { createTelemetry } from '@momonga/observability';
import type { Telemetry } from '@momonga/observability';
import { anthropicMessageEnd, anthropicMessageStart, anthropicStream, anthropicTextBlock, anthropicTextReply, createFakeClock, openResponsesTextReply } from '@momonga/testkit';
import type { FakeChatCompletionsServer, FakeClock, FakeScriptedReply } from '@momonga/testkit';
import { START_MS, postJson, readJson, registerCleanup, startGateway, userInput } from './gateway-helpers.ts';
import type { Harness } from './gateway-helpers.ts';
import { makeAdapter, startFake } from './cc-support.ts';
import { chunkLine, doneLine, makeOllamaAdapter, startFakeOllama } from './ollama-support.ts';
import { driveTimers } from './retry-support.ts';
import { startAnthropicGateway, startOpenResponsesGateway } from './upstream-gateway-support.ts';

const HEADER = 'Idempotency-Key';
const SENT = 'idempotency-key';
const FIRST = 'srv/first';
const SECOND = 'other/second';

const BOOM: FakeScriptedReply = { kind: 'error', status: 500, body: { error: { message: 'boom', type: 'server_error', param: null, code: null } } };
const REFUSED: FakeScriptedReply = { kind: 'error', status: 400, body: { error: { message: 'refused once', type: 'invalid_request_error', param: null, code: null } } };
const OK: FakeScriptedReply = { kind: 'stream', chunks: [{ delta: { role: 'assistant', content: 'ok' } }, { delta: {}, finishReason: 'stop' }] };

const sentKeys = (fake: FakeChatCompletionsServer, header = SENT): unknown[] =>
  fake.requests.filter((request) => request.path === '/v1/chat/completions').map((request) => request.headers[header]);

type Started = Harness & { fake: FakeChatCompletionsServer };

const startDeclared = async (
  script: FakeScriptedReply[],
  declared: string | null = HEADER,
  extra: { maxAttempts?: number; dir?: string; clock?: FakeClock; telemetry?: Telemetry } = {},
): Promise<Started> => {
  const fake = await startFake({ scenario: 'tools-ok', script });
  const harness = await startGateway({
    adapters: { [FIRST]: makeAdapter(fake) },
    config: {
      targets: { [FIRST]: { kind: 'chat-completions', ...(declared === null ? {} : { idempotencyKeyHeader: declared }) } },
      retry: { maxAttempts: extra.maxAttempts ?? 3 },
    },
    ...(extra.dir === undefined ? {} : { dir: extra.dir }),
    ...(extra.clock === undefined ? {} : { clock: extra.clock }),
    ...(extra.telemetry === undefined ? {} : { telemetry: extra.telemetry }),
  });
  return { ...harness, fake };
};

const call = (harness: Harness, key: string | undefined, text = 'hi', metadata: Record<string, string> = { run_id: 'run-1', step: '1' }, model = FIRST) =>
  postJson(harness.client, '/v1/responses', { model, input: userInput(text), metadata }, key === undefined ? {} : { 'idempotency-key': key });

describe('the idempotency key the gateway forwards on a model request (Q20)', () => {
  it('K1: a connection that declares no header receives none', async () => {
    const started = await startDeclared([OK], null);
    expect((await readJson(await call(started, 'key-1'))).status).toBe(200);
    expect(sentKeys(started.fake)).toEqual([undefined]);
  });

  it('K2: the declared header carries one value on the first send and on the resend the gateway makes after a failure', async () => {
    const started = await startDeclared([BOOM, OK]);
    const pending = call(started, 'key-1').then(readJson);
    await driveTimers(started, [pending]);
    expect((await pending).status).toBe(200);
    const keys = sentKeys(started.fake);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(keys[1]).toBe(keys[0]);
  });

  it('K2: the same request sent again by its caller after a failed answer carries the same value', async () => {
    const started = await startDeclared([REFUSED, OK], HEADER, { maxAttempts: 1 });
    expect((await readJson(await call(started, 'key-1'))).status).not.toBe(200);
    expect((await readJson(await call(started, 'key-1'))).status).toBe(200);
    const keys = sentKeys(started.fake);
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
  });

  it('K2: two requests carry different values, with the key of their caller and without one', async () => {
    const started = await startDeclared([OK, OK, OK, OK]);
    await readJson(await call(started, 'key-1', 'one'));
    await readJson(await call(started, 'key-2', 'two'));
    await readJson(await call(started, undefined, 'three'));
    await readJson(await call(started, undefined, 'three'));
    const keys = sentKeys(started.fake);
    expect(keys).toHaveLength(4);
    expect(new Set(keys).size).toBe(4);
    for (const key of keys) expect(key).toMatch(/^[0-9a-f]{64}$/);
  });

  it('K2: a request without a key of its caller carries one value across the resend the gateway makes', async () => {
    const started = await startDeclared([BOOM, OK]);
    const pending = call(started, undefined).then(readJson);
    await driveTimers(started, [pending]);
    expect((await pending).status).toBe(200);
    const keys = sentKeys(started.fake);
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
  });

  it('the header name is the one the connection declares', async () => {
    const started = await startDeclared([OK], 'X-Request-Token');
    await readJson(await call(started, 'key-1'));
    expect(sentKeys(started.fake, 'x-request-token')[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(sentKeys(started.fake)).toEqual([undefined]);
  });

  it('K3: the fallback model gets its own value, and a fallback that declares no header gets none', async () => {
    const first = await startFake({ scenario: 'tools-ok', script: [BOOM, BOOM] });
    const second = await startFake({ scenario: 'tools-ok', script: [OK] });
    const third = await startFake({ scenario: 'tools-ok', script: [OK] });
    const run = async (secondDeclared: boolean, fallback: FakeChatCompletionsServer): Promise<unknown[]> => {
      const harness = await startGateway({
        adapters: { [FIRST]: makeAdapter(first), [SECOND]: makeAdapter(fallback) },
        config: {
          targets: { [FIRST]: { kind: 'chat-completions', idempotencyKeyHeader: HEADER }, [SECOND]: { kind: 'chat-completions', ...(secondDeclared ? { idempotencyKeyHeader: HEADER } : {}) } },
          chains: { [FIRST]: [FIRST, SECOND] },
          retry: { maxAttempts: 1 },
        },
      });
      const pending = call(harness, 'key-1').then(readJson);
      await driveTimers(harness, [pending]);
      expect((await pending).status).toBe(200);
      return sentKeys(fallback);
    };
    const declared = await run(true, second);
    expect(declared[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(declared[0]).not.toBe(sentKeys(first)[0]);
    expect(await run(false, third)).toEqual([undefined]);
    expect(sentKeys(first)[1]).toBe(sentKeys(first)[0]);
  });
});

describe('every adapter that sends an HTTP request forwards the declared header', () => {
  it('anthropic', async () => {
    const gateway = await startAnthropicGateway({ script: [anthropicTextReply(['ok'])], config: { targets: { 'scripted/upstream-model': { kind: 'remote', idempotencyKeyHeader: HEADER } } } });
    expect((await readJson(await postJson(gateway.client, '/v1/responses', { model: 'scripted/upstream-model', input: userInput('hi') }, { 'idempotency-key': 'key-1' }))).status).toBe(200);
    expect(gateway.fake.requests.map((request) => request.headers[SENT])).toEqual([expect.stringMatching(/^[0-9a-f]{64}$/)]);
  });

  it('anthropic: each continuation of a paused turn is a different request body, so each carries its own value', async () => {
    const paused = anthropicStream([anthropicMessageStart(), ...anthropicTextBlock(0, ['start, ']), ...anthropicMessageEnd('pause_turn', { output_tokens: 5 })]);
    const gateway = await startAnthropicGateway({ script: [paused, anthropicTextReply(['end'])], config: { targets: { 'scripted/upstream-model': { kind: 'remote', idempotencyKeyHeader: HEADER } } } });
    expect((await readJson(await postJson(gateway.client, '/v1/responses', { model: 'scripted/upstream-model', input: userInput('hi') }, { 'idempotency-key': 'key-1' }))).status).toBe(200);
    const keys = gateway.fake.requests.map((request) => request.headers[SENT]);
    expect(keys).toHaveLength(2);
    expect(keys[1]).not.toBe(keys[0]);
    expect(String(keys[1]).startsWith(String(keys[0]))).toBe(true);
  });

  it('anthropic without the declaration sends none', async () => {
    const gateway = await startAnthropicGateway({ script: [anthropicTextReply(['ok'])] });
    await readJson(await postJson(gateway.client, '/v1/responses', { model: 'scripted/upstream-model', input: userInput('hi') }, { 'idempotency-key': 'key-1' }));
    expect(gateway.fake.requests.map((request) => request.headers[SENT])).toEqual([undefined]);
  });

  it('open-responses', async () => {
    const gateway = await startOpenResponsesGateway({ script: [openResponsesTextReply(['ok']), openResponsesTextReply(['ok'])], config: { targets: { 'scripted/upstream-model': { kind: 'remote', idempotencyKeyHeader: HEADER } } } });
    await readJson(await postJson(gateway.client, '/v1/responses', { model: 'scripted/upstream-model', input: userInput('hi') }, { 'idempotency-key': 'key-1' }));
    expect(gateway.fake.requests.map((request) => request.headers[SENT])).toEqual([expect.stringMatching(/^[0-9a-f]{64}$/)]);
  });

  it('ollama', async () => {
    const fake = await startFakeOllama({ chat: [{ kind: 'ndjson', lines: [chunkLine({ content: 'ok' }), doneLine()] }, { kind: 'ndjson', lines: [chunkLine({ content: 'ok' }), doneLine()] }] });
    const declared = await startGateway({ adapters: { 'ollama/devstral-small-2': makeOllamaAdapter(fake) }, config: { targets: { 'ollama/devstral-small-2': { kind: 'ollama', idempotencyKeyHeader: HEADER } } } });
    await readJson(await postJson(declared.client, '/v1/responses', { model: 'ollama/devstral-small-2', input: userInput('hi') }, { 'idempotency-key': 'key-1' }));
    const plain = await startGateway({ adapters: { 'ollama/devstral-small-2': makeOllamaAdapter(fake) }, config: { targets: { 'ollama/devstral-small-2': { kind: 'ollama' } } } });
    await readJson(await postJson(plain.client, '/v1/responses', { model: 'ollama/devstral-small-2', input: userInput('hi') }, { 'idempotency-key': 'key-1' }));
    expect(fake.requests.filter((request) => request.path === '/api/chat').map((request) => request.headers[SENT])).toEqual([expect.stringMatching(/^[0-9a-f]{64}$/), undefined]);
  });
});

describe('a second send of one model request is recorded as retry_of (Q20 B3, K4)', () => {
  const sendsOf = (dbPath: string): Array<{ seq: number; call_key: string; target: string; run_id: string | null; step: number | null }> => {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      return db.prepare('SELECT seq, call_key, target, run_id, step FROM sends ORDER BY seq').all() as never;
    } finally {
      db.close();
    }
  };

  const traced = (): { clock: FakeClock; telemetry: Telemetry; retryOfEachChat: () => Promise<unknown[]> } => {
    const clock = createFakeClock(START_MS);
    const memory = new InMemorySpanExporter();
    const telemetry = createTelemetry({ serviceName: 'momonga-gateway-test', serviceVersion: '0.0.0', clock, exporters: [memory], batch: { maxQueueSize: 2048, scheduledDelayMs: 60_000, maxExportBatchSize: 512 } });
    registerCleanup(() => telemetry.shutdown());
    const retryOfEachChat = async (): Promise<unknown[]> => {
      await telemetry.forceFlush();
      return memory
        .getFinishedSpans()
        .filter((finished) => finished.attributes['gen_ai.operation.name'] === 'chat')
        .map((finished) => finished.attributes['momonga.retry_of_seq']);
    };
    return { clock, telemetry, retryOfEachChat };
  };

  it('sends: the second send of a call is recorded under the key of the first, its span names the first send, and a first send names none', async () => {
    const { clock, telemetry, retryOfEachChat } = traced();
    const started = await startDeclared([REFUSED, OK, OK], HEADER, { maxAttempts: 1, clock, telemetry });
    expect((await readJson(await call(started, 'key-1'))).status).not.toBe(200);
    expect((await readJson(await call(started, 'key-1'))).status).toBe(200);
    expect((await readJson(await call(started, 'key-2', 'another', { run_id: 'run-1', step: '2' }))).status).toBe(200);
    const sends = sendsOf(started.dbPath);
    expect(sends.map((send) => [send.target, send.run_id, send.step])).toEqual([[FIRST, 'run-1', 1], [FIRST, 'run-1', 1], [FIRST, 'run-1', 2]]);
    expect(sends[1]?.call_key).toBe(sends[0]?.call_key);
    expect(sends[2]?.call_key).not.toBe(sends[0]?.call_key);
    expect(sends[0]?.call_key).toBe(sentKeys(started.fake)[0]);
    expect(await retryOfEachChat()).toEqual([undefined, sends[0]?.seq, undefined]);
  });

  it('sends: a second send is recorded for a connection that declares no header too', async () => {
    const { clock, telemetry, retryOfEachChat } = traced();
    const started = await startDeclared([REFUSED, OK], null, { maxAttempts: 1, clock, telemetry });
    await readJson(await call(started, 'key-1'));
    await readJson(await call(started, 'key-1'));
    const sends = sendsOf(started.dbPath);
    expect(sends).toHaveLength(2);
    expect(await retryOfEachChat()).toEqual([undefined, sends[0]?.seq]);
  });

  it('sends: the first send is known after the gateway restarts on the same database', async () => {
    const { clock, telemetry, retryOfEachChat } = traced();
    const before = await startDeclared([REFUSED], HEADER, { maxAttempts: 1, clock, telemetry });
    await readJson(await call(before, 'key-1'));
    await before.gateway.close();
    const after = await startDeclared([OK], HEADER, { maxAttempts: 1, dir: before.dir, clock, telemetry });
    const second = await readJson(await call(after, 'key-1'));
    expect(second.status).toBe(200);
    expect(sentKeys(after.fake)[0]).toBe(sentKeys(before.fake)[0]);
    expect(await retryOfEachChat()).toEqual([undefined, sendsOf(after.dbPath)[0]?.seq]);
  });

  it('trace: the span of a second send carries momonga.retry_of_seq, the span of a first send does not', async () => {
    const clock = createFakeClock(START_MS);
    const memory = new InMemorySpanExporter();
    const telemetry = createTelemetry({ serviceName: 'momonga-gateway-test', serviceVersion: '0.0.0', clock, exporters: [memory], batch: { maxQueueSize: 2048, scheduledDelayMs: 60_000, maxExportBatchSize: 512 } });
    registerCleanup(() => telemetry.shutdown());
    const started = await startDeclared([REFUSED, OK], HEADER, { maxAttempts: 1, clock, telemetry });
    await readJson(await call(started, 'key-1'));
    await readJson(await call(started, 'key-1'));
    await telemetry.forceFlush();
    const spans = memory.getFinishedSpans().filter((finished) => finished.attributes['gen_ai.operation.name'] === 'chat');
    expect(spans).toHaveLength(2);
    expect(spans[0]?.attributes).not.toHaveProperty('momonga.retry_of_seq');
    expect(spans[1]?.attributes['momonga.retry_of_seq']).toBe(sendsOf(started.dbPath)[0]?.seq);
  });
});
