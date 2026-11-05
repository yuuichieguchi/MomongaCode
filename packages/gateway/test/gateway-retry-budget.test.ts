import { describe, expect, it } from 'vitest';
import { createScriptedAdapter, textResponseEvents, waitFor } from '@momonga/testkit';
import { GATEWAY_CONFIG_DEFAULTS } from '../src/defaults.ts';
import { expectErrorBody, outputText, postJson, readJson, startGateway, userInput } from './gateway-helpers.ts';
import type { Harness } from './gateway-helpers.ts';

const TOTAL_WAIT_MS = 84_000;
const BASE_MS = 500;
const MAX_MS = 8000;
const RETRY = { totalWaitMs: TOTAL_WAIT_MS, baseMs: BASE_MS, maxMs: MAX_MS };
const BREAKER_OUT_OF_THE_WAY = { failureThreshold: 1000, openMs: 30_000 };
const HALF_JITTER_SERIES_MS = [250, 500, 1000, 2000, 4000];

const request = { model: 'fast', input: userInput('hi') };
const unavailable = (count: number) => Array.from({ length: count }, (_unused, index) => ({ failure: { status: 503, message: `down ${index + 1}` } }));
const rateLimited = (count: number, retryAfterMs: number) =>
  Array.from({ length: count }, (_unused, index) => ({ failure: { status: 429, message: `slow down ${index + 1}`, retryAfterMs } }));
const ok = (text: string) => ({ events: textResponseEvents({ model: 'scripted-primary', chunks: [text] }) });

type Primary = ReturnType<typeof createScriptedAdapter>;

const driveRetries = async (primary: Primary, harness: Harness, pending: Promise<unknown>): Promise<number[]> => {
  let settled = false;
  const markSettled = (): void => {
    settled = true;
  };
  void pending.then(markSettled, markSettled);
  const waits: number[] = [];
  for (;;) {
    const sends = waits.length + 1;
    await waitFor(() => settled || (primary.calls.length === sends && harness.timers.pending().length > 0), { description: `send ${sends} or the answer` });
    if (settled) return waits;
    const delay = harness.timers.pending().at(-1)?.delayMs ?? -1;
    waits.push(delay);
    harness.timers.advance(delay);
  }
};

const sum = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0);

const startBudgeted = (primary: Primary): Promise<Harness> =>
  startGateway({ adapters: { primary }, config: { retry: RETRY, breaker: BREAKER_OUT_OF_THE_WAY } });

describe('the gateway retry budget', () => {
  it('states the default budget as a total wait of 84 s', () => {
    expect(GATEWAY_CONFIG_DEFAULTS.retry).toMatchObject({ totalWaitMs: TOTAL_WAIT_MS });
  });

  it('keeps retrying an upstream that always answers 503 until the next wait would pass 84 s, then returns 502 server_error', async () => {
    const primary = createScriptedAdapter({ calls: unavailable(60) });
    const harness = await startBudgeted(primary);
    const pending = postJson(harness.client, '/v1/responses', request);

    const waits = await driveRetries(primary, harness, pending);
    const response = await readJson(await pending);

    expect(response.status).toBe(502);
    expectErrorBody(response.body, { type: 'server_error', code: 'upstream_error' });
    expect(waits.slice(0, HALF_JITTER_SERIES_MS.length)).toEqual(HALF_JITTER_SERIES_MS);
    expect(waits.every((wait) => wait >= 0 && wait <= MAX_MS)).toBe(true);
    expect(sum(waits)).toBeLessThanOrEqual(TOTAL_WAIT_MS);
    expect(sum(waits)).toBeGreaterThan(TOTAL_WAIT_MS - MAX_MS);
    expect(sum(waits)).toBe(83_750);
    expect(primary.calls).toHaveLength(waits.length + 1);
    expect(primary.calls).toHaveLength(25);
    expect(harness.timers.pending()).toEqual([]);
  });

  it('honours a Retry-After longer than retry.maxMs while it fits in the budget, and stops when the next one would not', async () => {
    const primary = createScriptedAdapter({ calls: rateLimited(10, 20_000) });
    const harness = await startBudgeted(primary);
    const pending = postJson(harness.client, '/v1/responses', request);

    const waits = await driveRetries(primary, harness, pending);
    const response = await readJson(await pending);

    expect(waits).toEqual([20_000, 20_000, 20_000, 20_000]);
    expect(primary.calls).toHaveLength(5);
    expect(response.status).toBe(429);
    expectErrorBody(response.body, { type: 'too_many_requests', code: 'rate_limited' });
    expect(response.headers['retry-after']).toBe('20');
    expect(harness.timers.pending()).toEqual([]);
  });

  it('succeeds after waiting out a Retry-After of 20 s', async () => {
    const primary = createScriptedAdapter({ calls: [...rateLimited(1, 20_000), ok('after the wait')] });
    const harness = await startBudgeted(primary);
    const pending = postJson(harness.client, '/v1/responses', request);

    const waits = await driveRetries(primary, harness, pending);
    const response = await readJson(await pending);

    expect(waits).toEqual([20_000]);
    expect(response.status).toBe(200);
    expect(outputText(response.body)).toBe('after the wait');
    expect(response.body.momonga.attempts).toBe(2);
  });

  it('cuts the budget short at a request deadline of 30 s and answers 504 deadline_exceeded', async () => {
    const primary = createScriptedAdapter({ calls: unavailable(60) });
    const harness = await startBudgeted(primary);
    const pending = postJson(harness.client, '/v1/responses', request, { 'momonga-deadline-ms': '30000' });

    const waits = await driveRetries(primary, harness, pending);
    const response = await readJson(await pending);

    expect(response.status).toBe(504);
    expectErrorBody(response.body, { type: 'server_error', code: 'deadline_exceeded' });
    expect(sum(waits)).toBe(27_750);
    expect(primary.calls).toHaveLength(11);
    expect(harness.timers.pending()).toEqual([]);
  });

  it('rides out a 44 s outage within one request: the upstream recovers and the caller gets 200 from a single send of its own', async () => {
    const primary = createScriptedAdapter({ calls: [...unavailable(14), ok('recovered')] });
    const harness = await startBudgeted(primary);
    const pending = postJson(harness.client, '/v1/responses', request);

    const waits = await driveRetries(primary, harness, pending);
    const response = await readJson(await pending);

    expect(sum(waits)).toBe(43_750);
    expect(response.status).toBe(200);
    expect(outputText(response.body)).toBe('recovered');
    expect(primary.calls).toHaveLength(15);
    expect(response.body.momonga.attempts).toBe(15);
  });
});
