import { describe, expect, it } from 'vitest';
import { createScriptedAdapter, textResponseEvents, waitFor } from '@momonga/testkit';
import { driveTimers } from './retry-support.ts';
import { expectErrorBody, getJson, outputText, postJson, readJson, startGateway, userInput } from './gateway-helpers.ts';

const ok = (model: string, text = 'ok') => ({ events: textResponseEvents({ model, chunks: [text] }) });
const request = { model: 'fast', input: userInput('hi') };

describe('retry', () => {
  it('waits at least retryAfterMs after a 429 before retrying, then succeeds', async () => {
    const primary = createScriptedAdapter({
      calls: [{ failure: { status: 429, message: 'slow down', retryAfterMs: 3000 } }, ok('scripted-primary', 'second try')],
    });
    const { client, timers } = await startGateway({ adapters: { primary } });
    const pending = postJson(client, '/v1/responses', request);
    await waitFor(() => primary.calls.length === 1 && timers.pending().length > 0, { description: 'retry timer' });
    const wait = timers.pending().at(-1);
    expect(wait?.delayMs).toBeGreaterThanOrEqual(3000);
    timers.advance(2999);
    expect(primary.calls).toHaveLength(1);
    timers.advance((wait?.delayMs ?? 0) - 2999);
    const response = await readJson(await pending);
    expect(response.status).toBe(200);
    expect(outputText(response.body)).toBe('second try');
    expect(primary.calls).toHaveLength(2);
    expect(primary.calls[1]?.attempt).toBe(2);
    expect(response.body.momonga.attempts).toBe(2);
  });

  it('falls back to the next target instead of sleeping through a Retry-After longer than retry.maxMs', async () => {
    const primary = createScriptedAdapter({ calls: [{ failure: { status: 429, message: 'slow down', retryAfterMs: 86_400_000 } }] });
    const secondary = createScriptedAdapter({ calls: [ok('scripted-secondary', 'from secondary')] });
    const { client, timers } = await startGateway({
      adapters: { primary, secondary },
      config: {
        aliases: { fast: ['primary', 'secondary'] },
        targets: { primary: { model: 'scripted-primary' }, secondary: { model: 'scripted-secondary' } },
        retry: { maxAttempts: 3, baseMs: 100, maxMs: 10_000 },
      },
    });
    const response = await readJson(await postJson(client, '/v1/responses', request));
    expect(response.status).toBe(200);
    expect(outputText(response.body)).toBe('from secondary');
    expect(response.body.momonga.fallbackFrom).toEqual(['primary']);
    expect(primary.calls).toHaveLength(1);
    expect(timers.pending().some((timer) => timer.delayMs > 10_000)).toBe(false);
  });

  it('returns the 429 with its Retry-After when the only target asks for a wait longer than retry.maxMs', async () => {
    const primary = createScriptedAdapter({ calls: [{ failure: { status: 429, message: 'slow down', retryAfterMs: 86_400_000 } }] });
    const { client } = await startGateway({ adapters: { primary }, config: { retry: { maxAttempts: 3, baseMs: 100, maxMs: 10_000 } } });
    const response = await readJson(await postJson(client, '/v1/responses', request));
    expect(response.status).toBe(429);
    expect(response.headers['retry-after']).toBe('86400');
    expect(primary.calls).toHaveLength(1);
  });

  it('does not retry a 400-class upstream error', async () => {
    const primary = createScriptedAdapter({ calls: [{ failure: { status: 422, message: 'bad schema' } }] });
    const { client, timers } = await startGateway({ adapters: { primary } });
    const response = await readJson(await postJson(client, '/v1/responses', request));
    expect(response.status).toBe(400);
    expectErrorBody(response.body, { type: 'invalid_request', code: 'upstream_rejected' });
    expect(response.body.error.message).toContain('bad schema');
    expect(primary.calls).toHaveLength(1);
    expect(timers.pending()).toEqual([]);
  });

  it('retries a 5xx on the only target past retry.maxAttempts with equal-jitter waits until the next wait would pass retry.totalWaitMs', async () => {
    const primary = createScriptedAdapter({
      calls: [
        { failure: { status: 500, message: 'e1' } },
        { failure: { status: 502, message: 'e2' } },
        { failure: { status: 503, message: 'e3' } },
        { failure: { status: 500, message: 'e4' } },
        ok('scripted-primary', 'never reached'),
      ],
    });
    const harness = await startGateway({
      adapters: { primary },
      config: { retry: { maxAttempts: 3, baseMs: 100, maxMs: 10_000, totalWaitMs: 1000 } },
    });
    const { client, timers } = harness;
    const pending = postJson(client, '/v1/responses', request);
    const waits = await driveTimers(harness, [pending]);
    const response = await readJson(await pending);
    expect(waits).toEqual([75, 150, 300]);
    expect(response.status).toBe(502);
    expectErrorBody(response.body, { type: 'server_error', code: 'upstream_error' });
    expect(response.body.error.message).toContain('e4');
    expect(primary.calls.map((call: { attempt: number }) => call.attempt)).toEqual([1, 2, 3, 4]);
    expect(timers.pending()).toEqual([]);
  });

  it('stops retrying with deadline_exceeded when the next wait would pass momonga-deadline-ms', async () => {
    const primary = createScriptedAdapter({
      calls: [{ failure: { status: 429, message: 'slow down', retryAfterMs: 5000 } }, ok('scripted-primary')],
    });
    const { client, timers } = await startGateway({ adapters: { primary } });
    const response = await readJson(await postJson(client, '/v1/responses', request, { 'momonga-deadline-ms': '1000' }));
    expect(response.status).toBe(504);
    expectErrorBody(response.body, { type: 'server_error', code: 'deadline_exceeded' });
    expect(primary.calls).toHaveLength(1);
    expect(timers.pending()).toEqual([]);
  });

  it('rejects a malformed momonga-deadline-ms header', async () => {
    const primary = createScriptedAdapter({ calls: [] });
    const { client } = await startGateway({ adapters: { primary } });
    const response = await readJson(await postJson(client, '/v1/responses', request, { 'momonga-deadline-ms': 'soon' }));
    expect(response.status).toBe(400);
    expectErrorBody(response.body, { type: 'invalid_request', code: 'invalid_deadline' });
    expect(primary.calls).toHaveLength(0);
  });
});

describe('circuit breaker', () => {
  it('skips a target with an open breaker without calling it and recovers via half-open after openMs', async () => {
    const a = createScriptedAdapter({ calls: [{ failure: { status: 503, message: 'a down' } }, ok('model-a', 'a back')] });
    const b = createScriptedAdapter({ calls: [ok('model-b', 'b one'), ok('model-b', 'b two')] });
    const { client, clock } = await startGateway({
      adapters: { a, b },
      config: {
        aliases: { fast: ['a', 'b'] },
        targets: { a: { model: 'model-a' }, b: { model: 'model-b' } },
        retry: { maxAttempts: 1 },
        breaker: { failureThreshold: 1, openMs: 10_000 },
      },
    });
    const first = await readJson(await postJson(client, '/v1/responses', request));
    expect(outputText(first.body)).toBe('b one');
    expect((await getJson(client, '/v1/momonga/health')).body.targets.a).toMatchObject({ breaker: 'open', ok: false });

    const second = await readJson(await postJson(client, '/v1/responses', request));
    expect(outputText(second.body)).toBe('b two');
    expect(second.body.momonga.fallbackFrom).toEqual(['a']);
    expect(a.calls).toHaveLength(1);

    clock.advance(10_000);
    const third = await readJson(await postJson(client, '/v1/responses', request));
    expect(outputText(third.body)).toBe('a back');
    expect(a.calls).toHaveLength(2);
    expect(b.calls).toHaveLength(2);
    const health = (await getJson(client, '/v1/momonga/health')).body;
    expect(health.targets.a).toMatchObject({ breaker: 'closed', ok: true });
    expect(health.targets.b).toMatchObject({ breaker: 'closed', ok: true });
  });

  it('ignores an open breaker when no later candidate exists and sends to the target anyway', async () => {
    const a = createScriptedAdapter({ calls: [{ failure: { status: 503, message: 'a down' } }, ok('model-a', 'a answers')] });
    const { client } = await startGateway({
      adapters: { a },
      config: {
        aliases: { fast: ['a'] },
        targets: { a: { model: 'model-a' } },
        retry: { maxAttempts: 1, totalWaitMs: 1 },
        breaker: { failureThreshold: 1, openMs: 10_000 },
      },
    });
    const failed = await readJson(await postJson(client, '/v1/responses', request));
    expect(failed.status).toBe(502);
    expect((await getJson(client, '/v1/momonga/health')).body.targets.a).toMatchObject({ breaker: 'open' });

    const response = await readJson(await postJson(client, '/v1/responses', request));

    expect(response.status).toBe(200);
    expect(outputText(response.body)).toBe('a answers');
    expect(a.calls).toHaveLength(2);
  });

  it('ignores an open breaker when the later candidate cannot pass either', async () => {
    const a = createScriptedAdapter({ calls: [{ failure: { status: 503, message: 'a down' } }, ok('model-a', 'a answers')] });
    const b = createScriptedAdapter({ calls: [{ failure: { status: 503, message: 'b down' } }] });
    const { client } = await startGateway({
      adapters: { a, b },
      config: {
        aliases: { fast: ['a', 'b'] },
        targets: { a: { model: 'model-a' }, b: { model: 'model-b' } },
        retry: { maxAttempts: 1, totalWaitMs: 1 },
        breaker: { failureThreshold: 1, openMs: 10_000 },
      },
    });
    const failed = await readJson(await postJson(client, '/v1/responses', request));
    expect(failed.status).toBe(502);
    const health = (await getJson(client, '/v1/momonga/health')).body;
    expect(health.targets.a).toMatchObject({ breaker: 'open' });
    expect(health.targets.b).toMatchObject({ breaker: 'open' });

    const response = await readJson(await postJson(client, '/v1/responses', request));

    expect(response.status).toBe(200);
    expect(outputText(response.body)).toBe('a answers');
    expect(response.body.momonga.fallbackFrom ?? []).toEqual([]);
    expect(b.calls).toHaveLength(1);
  });
});

describe('concurrency limiter', () => {
  const limited = {
    aliases: { fast: ['a'], other: ['b'] },
    targets: {
      a: { model: 'model-a', maxConcurrency: 1, admissionTimeoutMs: 5000 },
      b: { model: 'model-b' },
    },
  };

  it('makes a second concurrent request wait and admits it when the first finishes', async () => {
    const a = createScriptedAdapter({
      calls: [{ ...ok('model-a', 'first'), gate: { name: 'first', afterEvents: 0 } }, ok('model-a', 'second')],
    });
    const b = createScriptedAdapter({ calls: [] });
    const { client, timers } = await startGateway({ adapters: { a, b }, config: limited });
    const first = postJson(client, '/v1/responses', request);
    await waitFor(() => a.calls.length === 1);
    const second = postJson(client, '/v1/responses', request);
    await waitFor(() => timers.pending().some((timer) => timer.delayMs === 5000), { description: 'admission timer' });
    expect(a.calls).toHaveLength(1);
    a.release('first');
    expect(outputText((await readJson(await first)).body)).toBe('first');
    expect(outputText((await readJson(await second)).body)).toBe('second');
    expect(a.calls).toHaveLength(2);
    expect(timers.pending()).toEqual([]);
  });

  it('answers 429 too_many_requests with Retry-After when admission waits longer than admissionTimeoutMs', async () => {
    const a = createScriptedAdapter({ calls: [{ ...ok('model-a', 'first'), gate: { name: 'first', afterEvents: 0 } }] });
    const b = createScriptedAdapter({ calls: [ok('model-b', 'unaffected')] });
    const { client, timers } = await startGateway({ adapters: { a, b }, config: limited });
    const first = postJson(client, '/v1/responses', request);
    await waitFor(() => a.calls.length === 1);
    const second = postJson(client, '/v1/responses', request);
    await waitFor(() => timers.pending().some((timer) => timer.delayMs === 5000), { description: 'admission timer' });

    const other = await readJson(await postJson(client, '/v1/responses', { model: 'other', input: userInput('hi') }));
    expect(outputText(other.body)).toBe('unaffected');

    timers.advance(5000);
    const rejected = await readJson(await second);
    expect(rejected.status).toBe(429);
    expectErrorBody(rejected.body, { type: 'too_many_requests', code: 'admission_timeout' });
    expect(Number(rejected.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect(Number.isInteger(Number(rejected.headers['retry-after']))).toBe(true);
    expect(a.calls).toHaveLength(1);

    a.release('first');
    expect((await readJson(await first)).status).toBe(200);
  });
});
