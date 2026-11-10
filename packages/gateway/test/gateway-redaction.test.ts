import { describe, expect, it } from 'vitest';
import { keyAuthSource } from '@momonga/gateway';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace';
import type { ReadableSpan } from '@opentelemetry/sdk-trace';
import { MAX_JSON_DEPTH, createJsonLogger } from '@momonga/foundation';
import type { TextStream } from '@momonga/foundation';
import { createTelemetry } from '@momonga/observability';
import type { ClassifiedError, ProviderAdapter, StreamEvent } from '@momonga/protocol';
import { createFakeClock, createScriptedAdapter, responseResource, textResponseEvents } from '@momonga/testkit';
import { GatewayError } from '../src/core/errors.ts';
import { capabilityFailingAdapter } from './capability-failing-adapter.ts';
import { START_MS, getJson, postJson, readJson, readSse, registerCleanup, startGateway, userInput } from './gateway-helpers.ts';
import type { SseFrame } from './gateway-helpers.ts';
import { makeAdapter, startFake } from './cc-support.ts';
import { REDACTED, REDACTED_401, TEST_API_KEY, expectNoCredential, expectRedacted } from './credential-support.ts';

const ECHO_401 = {
  error: { message: `Incorrect API key provided: ${TEST_API_KEY}`, type: 'invalid_request_error', param: null, code: 'invalid_api_key' },
};

const memoryTelemetry = () => {
  const clock = createFakeClock(START_MS);
  const memory = new InMemorySpanExporter();
  const telemetry = createTelemetry({
    serviceName: 'momonga-gateway-test',
    serviceVersion: '0.0.0',
    clock,
    exporters: [memory],
    batch: { maxQueueSize: 2048, scheduledDelayMs: 60_000, maxExportBatchSize: 512 },
  });
  registerCleanup(() => telemetry.shutdown());
  return { clock, memory, telemetry };
};

const spanText = (spans: readonly ReadableSpan[]): string =>
  JSON.stringify(spans.map((span) => ({ name: span.name, attributes: span.attributes, status: span.status, events: span.events })));

const captureLog = (): TextStream & { text(): string } => {
  const chunks: string[] = [];
  return {
    write: (chunk: string) => {
      chunks.push(chunk);
      return true;
    },
    text: () => chunks.join(''),
  };
};

const framesText = (frames: readonly SseFrame[]): string => JSON.stringify(frames);

const cleanupFailingAdapter = (events: readonly StreamEvent[]): ProviderAdapter => ({
  ...createScriptedAdapter({ calls: [] }),
  create: () => ({
    [Symbol.asyncIterator]: () => {
      let index = 0;
      return {
        next: async () => (index < events.length ? { done: false as const, value: events[index++] as StreamEvent } : { done: true as const, value: undefined }),
        return: async () => {
          throw new Error(`cleanup failed for ${TEST_API_KEY}`);
        },
      };
    },
  }),
});

const eventsAdapter = (events: readonly StreamEvent[], classify?: ProviderAdapter['classify']): ProviderAdapter => {
  const base = createScriptedAdapter({ calls: [{ events }] });
  return classify === undefined ? base : { ...base, create: base.create, classify };
};

const failingAdapter = (classified: ClassifiedError): ProviderAdapter => {
  const base = createScriptedAdapter({ calls: [{ failure: { status: 400, message: 'rejected' } }] });
  return { ...base, create: base.create, classify: () => classified };
};

describe('T6: traces hold redacted upstream text', () => {
  it('records a redacted exception.message on the failed chat span for a 401 echo', async () => {
    const fake = await startFake({ scenario: 'tools-ok', routes: [{ match: () => true, reply: { kind: 'error', status: 401, body: ECHO_401 } }] });
    const { clock, memory, telemetry } = memoryTelemetry();
    const primary = makeAdapter(fake, { authSource: keyAuthSource(async () => TEST_API_KEY) });
    const { client } = await startGateway({ adapters: { primary }, clock, telemetry, credentials: [TEST_API_KEY] });
    const response = await readJson(await postJson(client, '/v1/responses', { model: 'fast', input: userInput('hi') }));
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('authentication_failed');
    expect(response.body.error.message).toBe(REDACTED_401);
    await telemetry.forceFlush();
    const chats = memory.getFinishedSpans().filter((span) => span.attributes['gen_ai.operation.name'] === 'chat');
    expect(chats).toHaveLength(1);
    const exception = chats[0]?.events.find((event) => event.name === 'exception');
    expect(exception?.attributes?.['exception.message']).toBe(REDACTED_401);
    expectRedacted(spanText(memory.getFinishedSpans()), TEST_API_KEY);
  });

  it('records a redacted momonga.adapter_cleanup_error when the iterator return() throws', async () => {
    const { clock, memory, telemetry } = memoryTelemetry();
    const primary = cleanupFailingAdapter(textResponseEvents({ model: 'scripted-primary', chunks: ['done'] }));
    const { client } = await startGateway({ adapters: { primary }, clock, telemetry, credentials: [TEST_API_KEY] });
    const response = await readJson(await postJson(client, '/v1/responses', { model: 'fast', input: userInput('hi') }));
    expect(response.status).toBe(200);
    await telemetry.forceFlush();
    const cleanup = memory
      .getFinishedSpans()
      .flatMap((span) => span.events)
      .find((event) => event.name === 'momonga.adapter_cleanup_error');
    expect(cleanup?.attributes?.['message']).toBe(`cleanup failed for ${REDACTED}`);
    expectRedacted(spanText(memory.getFinishedSpans()), TEST_API_KEY);
  });
});

describe('T8: unknown and GatewayError failures cross the guard redacted', () => {
  it('lists a target whose capabilities() throws as unavailable with a redacted message', async () => {
    const broken = capabilityFailingAdapter({ inner: createScriptedAdapter({ calls: [] }), fails: () => new Error(`boom ${TEST_API_KEY}`) });
    const { client } = await startGateway({ adapters: { primary: broken }, credentials: [TEST_API_KEY] });
    const response = await client.request({ method: 'GET', path: '/v1/momonga/models' });
    const body = await response.text();
    expect(response.status).toBe(200);
    const entry = (JSON.parse(body).data as Array<{ targets: string[]; capabilities: unknown }>).find((candidate) => candidate.targets.includes('primary'));
    expect(entry?.capabilities).toEqual({ toolCalling: { state: 'unavailable', status: 502, type: 'server_error', code: 'adapter_error', message: `boom ${REDACTED}` }, source: 'unprobed' });
    expectRedacted(body, TEST_API_KEY);
  });

  it('answers a redacted 500 and logs a redacted message and stack when the cost report throws', async () => {
    const log = captureLog();
    const logger = createJsonLogger({ service: 'gateway', clock: createFakeClock(START_MS), stream: log });
    const { client } = await startGateway({
      adapters: { primary: createScriptedAdapter({ calls: [] }) },
      credentials: [TEST_API_KEY],
      onError: (error) => logger.error('unhandled gateway error', { err: error instanceof Error ? error : new Error(String(error)) }),
      costReport: async () => {
        throw new Error(`boom ${TEST_API_KEY}`);
      },
    });
    const response = await postJson(client, '/v1/momonga/cost', { runs: [], includeRunless: false });
    const body = await response.text();
    expect(response.status).toBe(500);
    expect(JSON.parse(body).error).toMatchObject({ code: 'internal_error', message: `boom ${REDACTED}` });
    expectRedacted(body, TEST_API_KEY);
    const lines = log.text();
    expect(lines).toContain('unhandled gateway error');
    expect(lines).toContain('"stack"');
    expectRedacted(lines, TEST_API_KEY);
  });

  it('keeps status, code and param of a GatewayError thrown by an adapter and redacts its message', async () => {
    const thrower: ProviderAdapter = {
      ...createScriptedAdapter({ calls: [] }),
      create: () => {
        throw new GatewayError({ status: 400, type: 'invalid_request', code: 'invalid_body', param: 'input[0]', message: `bad body ${TEST_API_KEY}` });
      },
    };
    const { client } = await startGateway({ adapters: { primary: thrower }, credentials: [TEST_API_KEY] });
    const response = await readJson(await postJson(client, '/v1/responses', { model: 'fast', input: userInput('hi') }));
    expect(response.status).toBe(400);
    expect(response.body.error).toEqual({ type: 'invalid_request', code: 'invalid_body', param: 'input[0]', message: `bad body ${REDACTED}` });
  });
});

describe('a request-body error quotes nothing of the body', () => {
  it.each([
    { label: 'a short body that is the bare credential', sent: TEST_API_KEY },
    { label: 'a long body with the credential at the failing position', sent: `{"a":1,"padding":"${'p'.repeat(200)}","key":${TEST_API_KEY}}` },
  ])('answers invalid_json with the fixed message for $label', async ({ sent }) => {
    const { client } = await startGateway({ adapters: { primary: createScriptedAdapter({ calls: [] }) }, credentials: [TEST_API_KEY] });
    const response = await client.request({ method: 'POST', path: '/v1/responses', headers: { 'content-type': 'application/json' }, body: sent });
    const text = await response.text();
    expect(response.status).toBe(400);
    expect(JSON.parse(text)).toEqual({ error: { message: 'the request body is not valid JSON', type: 'invalid_request', param: null, code: 'invalid_json' } });
    expectNoCredential(text, TEST_API_KEY);
  });

  it('answers json_too_deep with the gateway wording and the depth limit only', async () => {
    const depth = MAX_JSON_DEPTH + 1;
    const sent = `{"key":"${TEST_API_KEY}","extra":${'['.repeat(depth - 1)}${']'.repeat(depth - 1)}}`;
    const { client } = await startGateway({ adapters: { primary: createScriptedAdapter({ calls: [] }) }, credentials: [TEST_API_KEY] });
    const response = await client.request({ method: 'POST', path: '/v1/responses', headers: { 'content-type': 'application/json' }, body: sent });
    const text = await response.text();
    expect(response.status).toBe(400);
    expect(JSON.parse(text)).toEqual({
      error: { message: 'the request body is too deeply nested: JSON depth exceeds the limit of 128', type: 'invalid_request', param: null, code: 'json_too_deep' },
    });
    expectNoCredential(text, TEST_API_KEY);
  });
});

describe('a validation error body crosses the redactor at the exit', () => {
  it('redacts a credential that the validator quotes as an unknown item type', async () => {
    const { client } = await startGateway({ adapters: { primary: createScriptedAdapter({ calls: [] }) }, credentials: [TEST_API_KEY] });
    const response = await postJson(client, '/v1/responses', { model: 'fast', input: [{ type: TEST_API_KEY }] });
    const text = await response.text();
    expect(response.status).toBe(400);
    expect(JSON.parse(text)).toEqual({ error: { message: `input[0].type has unknown item type "${REDACTED}"`, type: 'invalid_request', param: 'input[0].type', code: 'invalid_body' } });
    expectRedacted(text, TEST_API_KEY);
  });
});

describe('T9: a mid-stream error event is redacted', () => {
  it('redacts the message of an error event forwarded in the SSE stream', async () => {
    const events = textResponseEvents({ model: 'scripted-primary', chunks: ['a', 'b'] });
    const withError: StreamEvent[] = [
      ...events.slice(0, 4),
      { type: 'error', sequence_number: 4, error: { message: `upstream hiccup ${TEST_API_KEY}`, type: 'server_error', code: 'upstream_error', param: null } },
      ...events.slice(4),
    ];
    const { client } = await startGateway({ adapters: { primary: eventsAdapter(withError) }, credentials: [TEST_API_KEY] });
    const frames = await readSse(await postJson(client, '/v1/responses', { model: 'fast', input: userInput('hi'), stream: true }));
    const errorFrame = frames.find((frame) => frame.data.type === 'error');
    expect(errorFrame?.data.error).toEqual({ message: `upstream hiccup ${REDACTED}`, type: 'server_error', code: 'upstream_error', param: null });
    expectRedacted(framesText(frames), TEST_API_KEY);
  });
});

const classified = (code: string | null, param: string | null): ClassifiedError => ({
  retryable: false,
  error: { type: 'invalid_request', code, message: 'rejected by the upstream', param },
});

describe('T10: codes and params are forwarded or dropped by shape', () => {
  it.for([
    { label: 'the code context_length_exceeded is kept', code: 'context_length_exceeded', param: null, expected: { code: 'context_length_exceeded', param: null } },
    { label: 'a code of 70 characters fails the shape check and the failure carries upstream_error', code: 'c'.repeat(70), param: null, expected: { code: 'upstream_error', param: null } },
    { label: 'a code with a space fails the shape check and the failure carries upstream_error', code: 'bad code', param: null, expected: { code: 'upstream_error', param: null } },
    { label: 'an upstream 4xx without a code still gives the failure the code upstream_error', code: null, param: null, expected: { code: 'upstream_error', param: null } },
    {
      label: 'the param input[0].encrypted_content is kept',
      code: 'invalid_body',
      param: 'input[0].encrypted_content',
      expected: { code: 'invalid_body', param: 'input[0].encrypted_content' },
    },
    { label: 'a param of 200 characters becomes null', code: 'invalid_body', param: 'p'.repeat(200), expected: { code: 'invalid_body', param: null } },
    { label: 'a param with a space becomes null', code: 'invalid_body', param: 'input 0', expected: { code: 'invalid_body', param: null } },
    { label: 'a code equal to the configured key is scrubbed and the failure carries upstream_error', code: TEST_API_KEY, param: null, expected: { code: 'upstream_error', param: null } },
    { label: 'a param equal to the configured key becomes null', code: 'invalid_body', param: TEST_API_KEY, expected: { code: 'invalid_body', param: null } },
  ])('classify: $label', async ({ code, param, expected }) => {
    const { client } = await startGateway({ adapters: { primary: failingAdapter(classified(code, param)) }, credentials: [TEST_API_KEY] });
    const response = await readJson(await postJson(client, '/v1/responses', { model: 'fast', input: userInput('hi') }));
    expect(response.status).toBe(400);
    expect({ code: response.body.error.code, param: response.body.error.param }).toEqual(expected);
  });

  it.for([
    { label: 'a code of 70 characters', code: 'c'.repeat(70), param: 'input[0]', expected: { code: 'upstream_error', param: 'input[0]' } },
    { label: 'a param of 200 characters', code: 'upstream_error', param: 'p'.repeat(200), expected: { code: 'upstream_error', param: null } },
    { label: 'a param with a space', code: 'upstream_error', param: 'input 0', expected: { code: 'upstream_error', param: null } },
    { label: 'a code equal to the configured key', code: TEST_API_KEY, param: 'input[0]', expected: { code: 'upstream_error', param: 'input[0]' } },
    { label: 'a param equal to the configured key', code: 'upstream_error', param: TEST_API_KEY, expected: { code: 'upstream_error', param: null } },
    { label: 'a valid code and param', code: 'context_length_exceeded', param: 'input[0].encrypted_content', expected: { code: 'context_length_exceeded', param: 'input[0].encrypted_content' } },
  ])('error event: $label', async ({ code, param, expected }) => {
    const events = textResponseEvents({ model: 'scripted-primary', chunks: ['a'] });
    const withError: StreamEvent[] = [
      ...events.slice(0, 4),
      { type: 'error', sequence_number: 4, error: { message: 'hiccup', type: 'server_error', code, param } },
      ...events.slice(4),
    ];
    const { client } = await startGateway({ adapters: { primary: eventsAdapter(withError) }, credentials: [TEST_API_KEY] });
    const frames = await readSse(await postJson(client, '/v1/responses', { model: 'fast', input: userInput('hi'), stream: true }));
    const errorFrame = frames.find((frame) => frame.data.type === 'error');
    expect({ code: errorFrame?.data.error.code, param: errorFrame?.data.error.param }).toEqual(expected);
  });

  it.for([
    { label: 'a code of 70 characters', code: 'c'.repeat(70), leaked: 'c'.repeat(70) },
    { label: 'a code that carries a space', code: 'leaky code value', leaked: 'leaky code value' },
    { label: 'a code equal to the configured key', code: TEST_API_KEY, leaked: TEST_API_KEY },
  ])('response.failed before output: $label is not forwarded, and the error carries the gateway code upstream_error', async ({ code, leaked }) => {
    const created = textResponseEvents({ model: 'scripted-primary', chunks: ['a'] }).slice(0, 2);
    const failed = {
      type: 'response.failed',
      sequence_number: 2,
      response: { ...responseResource({ id: 'upstream_resp_1', model: 'scripted-primary', status: 'failed' }), error: { code, message: 'failed', type: 'server_error' } },
    } as unknown as StreamEvent;
    const { client } = await startGateway({
      adapters: { primary: eventsAdapter([...created, failed]) },
      credentials: [TEST_API_KEY],
      config: { retry: { totalWaitMs: 1 } },
    });
    const reply = await readJson(await postJson(client, '/v1/responses', { model: 'fast', input: userInput('hi'), stream: true }));
    expect(reply.status).toBe(502);
    expect(reply.body.error.code).toBe('upstream_error');
    expect(JSON.stringify(reply.body)).not.toContain(leaked);
  });
});

describe('every failure the gateway forwards carries a code', () => {
  it('never forwards a failure without a code: a scrubbed upstream code after output becomes upstream_error', async () => {
    const afterOutput = [
      ...textResponseEvents({ model: 'scripted-primary', chunks: ['a'] }).slice(0, 5),
      {
        type: 'response.failed',
        sequence_number: 5,
        response: { ...responseResource({ id: 'upstream_resp_1', model: 'scripted-primary', status: 'failed' }), error: { code: 'leaky code value', message: 'failed', type: 'server_error' } },
      } as unknown as StreamEvent,
    ];
    const { client } = await startGateway({ adapters: { primary: eventsAdapter(afterOutput) }, credentials: [TEST_API_KEY] });
    const frames = await readSse(await postJson(client, '/v1/responses', { model: 'fast', input: userInput('hi'), stream: true }));
    expect(frames.at(-1)?.data.type).toBe('response.failed');
    expect(frames.at(-1)?.data.response.error.code).toBe('upstream_error');
  });
});

describe('T4: count_tokens on a chat-completions target stays local', () => {
  it('estimates without calling the upstream', async () => {
    const fake = await startFake({ scenario: 'tools-ok' });
    const primary = makeAdapter(fake, { authSource: keyAuthSource(async () => TEST_API_KEY) });
    const { client } = await startGateway({ adapters: { primary }, credentials: [TEST_API_KEY] });
    const response = await readJson(await postJson(client, '/v1/momonga/count_tokens', { model: 'fast', input: 'one two three' }));
    expect(response.status).toBe(200);
    expect(response.body.method).toBe('estimated');
    expect(fake.requests.filter((request) => request.path === '/v1/chat/completions')).toEqual([]);
  });

  it('redacts the 401 echo on /v1/responses/compact', async () => {
    const fake = await startFake({ scenario: 'tools-ok', routes: [{ match: () => true, reply: { kind: 'error', status: 401, body: ECHO_401 } }] });
    const primary = makeAdapter(fake, { authSource: keyAuthSource(async () => TEST_API_KEY) });
    const { client } = await startGateway({ adapters: { primary }, credentials: [TEST_API_KEY] });
    const response = await client.request({
      method: 'POST',
      path: '/v1/responses/compact',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'fast',
        input: [
          ...userInput('Fix the parser bug'),
          { type: 'function_call', call_id: 'c1', name: 'Read', arguments: '{"path":"src/parse.ts"}' },
          { type: 'function_call_output', call_id: 'c1', output: 'export const parse = 1;' },
        ],
      }),
    });
    const text = await response.text();
    expect(response.status).toBe(401);
    expect(JSON.parse(text).error.message).toBe(REDACTED_401);
    expectRedacted(text, TEST_API_KEY);
  });
});

describe('guarded health in the gateway', () => {
  it('answers GET /v1/momonga/health with a redacted detail when health() throws', async () => {
    const sick: ProviderAdapter = {
      ...createScriptedAdapter({ calls: [] }),
      health: async () => {
        throw new Error(`probe failed ${TEST_API_KEY}`);
      },
    };
    const { client } = await startGateway({ adapters: { primary: sick }, credentials: [TEST_API_KEY] });
    const health = await getJson(client, '/v1/momonga/health');
    expect(health.body.targets.primary).toMatchObject({ ok: false, reason: 'health_check_failed', detail: `probe failed ${REDACTED}` });
    expectNoCredential(JSON.stringify(health.body), TEST_API_KEY);
  });
});
