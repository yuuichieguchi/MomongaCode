import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ADAPTER_NEUTRAL_ERROR_CODES } from '@momonga/protocol';
import { JSON_OBJECT_UNSUPPORTED_MESSAGE, waitFor } from '@momonga/testkit';
import { makeDir } from './gateway-helpers.ts';
import { TARGET, collect, makeAdapter, startFake, userText } from './cc-support.ts';

const plain = { model: 'system', input: [userText('hi')] };

const classified = async (fake: Awaited<ReturnType<typeof startFake>>, input = plain) => {
  const adapter = makeAdapter(fake);
  const { events, error } = await collect(adapter, input);
  expect(events).toEqual([]);
  expect(error).toBeDefined();
  return adapter.classify(error);
};

const errorBody = (message: string, code: string | null = null) => ({
  error: { message, type: 'invalid_request_error', param: null, code },
});

describe('chat-completions error classification', () => {
  it('maps 429 to a retryable too_many_requests honouring Retry-After seconds', async () => {
    const fake = await startFake({
      scenario: 'tools-ok',
      script: [{ kind: 'error', status: 429, body: { error: { message: 'slow down', type: 'rate_limit_error', param: null, code: 'rate_limit_exceeded' } }, headers: { 'retry-after': '2' } }],
    });
    const result = await classified(fake);
    expect(result.retryable).toBe(true);
    expect(result.retryAfterMs).toBe(2000);
    expect(result.error.type).toBe('too_many_requests');
  });

  it('fails a stream that sends only [DONE] with the retryable empty_upstream_stream before any event', async () => {
    const fake = await startFake({ scenario: 'tools-ok', script: [{ kind: 'raw-sse', events: ['[DONE]'] }] });
    const result = await classified(fake);
    expect(result.retryable).toBe(true);
    expect(result.error.code).toBe('empty_upstream_stream');
  });

  it.each([500, 502, 503])('maps %i to a retryable server_error', async (status) => {
    const fake = await startFake({
      scenario: 'tools-ok',
      script: [{ kind: 'error', status, body: { error: { message: 'boom', type: 'server_error', param: null, code: null } } }],
    });
    const result = await classified(fake);
    expect(result.retryable).toBe(true);
    expect(result.error.type).toBe('server_error');
  });

  it('maps 413 to a non-retryable invalid_request payload_too_large', async () => {
    const fake = await startFake({ scenario: 'tools-ok', contextWindow: 8, contextOverflowStatus: 413 });
    const result = await classified(fake, { model: 'system', input: [userText('one two three four five six seven eight nine ten')] });
    expect(result.retryable).toBe(false);
    expect(result.error).toMatchObject({ type: 'invalid_request', code: 'payload_too_large' });
  });

  it('maps an OpenAI-style context_length_exceeded rejection to the unified context_window_exceeded invalid_request', async () => {
    const fake = await startFake({ scenario: 'tools-ok', contextWindow: 8 });
    const result = await classified(fake, { model: 'system', input: [userText('one two three four five six seven eight nine ten')] });
    expect(result.retryable).toBe(false);
    expect(result.error).toMatchObject({ type: 'invalid_request', code: 'context_window_exceeded' });
  });

  it('maps a guardrail rejection to a neutral model_error guardrail_violation', async () => {
    const fake = await startFake({ scenario: 'tools-ok', guardrailTrigger: 'forbidden' });
    const result = await classified(fake, { model: 'system', input: [userText('say something forbidden')] });
    expect(result.retryable).toBe(false);
    expect(result.error).toMatchObject({ type: 'model_error', code: 'guardrail_violation' });
    expect(ADAPTER_NEUTRAL_ERROR_CODES).toContain(result.error.code);
  });

  it('maps a json_object rejection to a non-retryable invalid_request carrying the upstream message', async () => {
    const fake = await startFake({
      scenario: 'tools-ok',
      script: [{ kind: 'error', status: 400, body: errorBody(JSON_OBJECT_UNSUPPORTED_MESSAGE) }],
    });
    const result = await classified(fake);
    expect(result.retryable).toBe(false);
    expect(result.error.type).toBe('invalid_request');
    expect(result.error.message).toContain(JSON_OBJECT_UNSUPPORTED_MESSAGE);
  });

  it('maps any other 400 to a non-retryable invalid_request', async () => {
    const fake = await startFake({ scenario: 'tools-ok', script: [{ kind: 'error', status: 400, body: errorBody('bad field') }] });
    const result = await classified(fake);
    expect(result.retryable).toBe(false);
    expect(result.error.type).toBe('invalid_request');
  });

  it('maps a missing socket to a retryable server_error provider_unavailable', async () => {
    const fake = await startFake({ scenario: 'tools-ok' });
    const missing = path.join(makeDir(), 'absent.sock');
    const adapter = makeAdapter(fake, { resolveEndpoint: async () => ({ kind: 'unix', socketPath: missing }) });
    const { events, error } = await collect(adapter, plain);
    expect(events).toEqual([]);
    const result = adapter.classify(error);
    expect(result.retryable).toBe(true);
    expect(result.error).toMatchObject({ type: 'server_error', code: 'provider_unavailable' });
  });

  it('maps a refused tcp connection to a retryable server_error provider_unavailable', async () => {
    const fake = await startFake({ scenario: 'tools-ok' });
    const adapter = makeAdapter(fake, { resolveEndpoint: async () => ({ kind: 'tcp', baseUrl: 'http://127.0.0.1:1' }) });
    const { error } = await collect(adapter, plain);
    expect(adapter.classify(error)).toMatchObject({ retryable: true, error: { type: 'server_error', code: 'provider_unavailable' } });
  });

  it('stops the upstream request on abort and yields no further events', async () => {
    const fake = await startFake({
      scenario: 'tools-ok',
      script: [{ kind: 'hang', chunks: [{ delta: { role: 'assistant', content: 'partial' } }] }],
    });
    const controller = new AbortController();
    const adapter = makeAdapter(fake);
    const iterator = adapter.create(plain, { signal: controller.signal, target: TARGET, attempt: 1 })[Symbol.asyncIterator]();
    const seen: string[] = [];
    for (;;) {
      const step = await iterator.next();
      if (step.done === true) throw new Error('stream ended before the first delta');
      seen.push(step.value.type);
      if (step.value.type === 'response.output_text.delta') break;
    }
    controller.abort();
    const after: string[] = [];
    try {
      for (;;) {
        const step = await iterator.next();
        if (step.done === true) break;
        after.push(step.value.type);
      }
    } catch {
      after.push('<thrown>');
    }
    expect(after.filter((type) => type !== '<thrown>')).toEqual([]);
    await waitFor(() => fake.disconnects() === 1);
    expect(fake.disconnects()).toBe(1);
    expect(seen).toContain('response.output_text.delta');
  });
});
