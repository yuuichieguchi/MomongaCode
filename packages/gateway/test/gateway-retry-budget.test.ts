import { describe, expect, it } from 'vitest';
import { createFakeClock, createFakeTimers, createScriptedAdapter } from '@momonga/testkit';
import type { PendingTimer } from '@momonga/testkit';
import { GATEWAY_CONFIG_DEFAULTS } from '../src/defaults.ts';
import { START_MS, expectErrorBody, outputText, postJson, readJson, startGateway } from './gateway-helpers.ts';
import type { ConfigOverrides, Harness } from './gateway-helpers.ts';
import {
  BREAKER_OUT_OF_THE_WAY,
  BUDGET,
  DEFERRED_HEADER,
  MAX_MS,
  TOTAL_WAIT_MS,
  capOf,
  driveTimers,
  ok,
  rateLimited,
  request,
  sum,
  unavailable,
} from './retry-support.ts';

const EQUAL_JITTER_AT_HALF_MS = [375, 750, 1500, 3000, 6000, ...Array.from({ length: 12 }, () => 6000)];
const EQUAL_JITTER_AT_HALF_TOTAL_MS = 83_625;
const SENDS_AT_HALF = 18;
const EQUAL_JITTER_AT_ZERO_MS = [250, 500, 1000, 2000, 4000, ...Array.from({ length: 19 }, () => 4000)];
const EQUAL_JITTER_AT_ZERO_TOTAL_MS = 83_750;
const SENDS_BOUND = 25;

type Primary = ReturnType<typeof createScriptedAdapter>;

const startBudgeted = (primary: Primary, config: ConfigOverrides = {}, random?: () => number): Promise<Harness> =>
  startGateway({
    adapters: { primary },
    config: { retry: BUDGET, breaker: BREAKER_OUT_OF_THE_WAY, ...config },
    ...(random === undefined ? {} : { random }),
  });

describe('the gateway retry budget', () => {
  it('states the default budget as a total wait of 84 s with equal jitter between 500 ms and 8 s', () => {
    expect(GATEWAY_CONFIG_DEFAULTS.retry).toEqual({ maxAttempts: 3, totalWaitMs: TOTAL_WAIT_MS, baseMs: 500, maxMs: 8000 });
  });

  it('waits 3/4 of each cap at random 0.5 and stops when the next wait would pass 84 s: 17 waits of 83 625 ms, 18 sends, then 502 server_error', async () => {
    const primary = createScriptedAdapter({ calls: unavailable(60) });
    const harness = await startBudgeted(primary);
    const pending = postJson(harness.client, '/v1/responses', request);

    const waits = await driveTimers(harness, [pending]);
    const response = await readJson(await pending);

    expect(response.status).toBe(502);
    expectErrorBody(response.body, { type: 'server_error', code: 'upstream_error' });
    expect(waits).toEqual(EQUAL_JITTER_AT_HALF_MS);
    expect(sum(waits)).toBe(EQUAL_JITTER_AT_HALF_TOTAL_MS);
    expect(primary.calls).toHaveLength(SENDS_AT_HALF);
    expect(response.headers[DEFERRED_HEADER]).toBeUndefined();
    expect(harness.timers.pending()).toEqual([]);
  });

  it('waits at least half of each cap at random 0, which reaches the proved bound of 25 sends and no more', async () => {
    const primary = createScriptedAdapter({ calls: unavailable(60) });
    const harness = await startBudgeted(primary, {}, () => 0);
    const pending = postJson(harness.client, '/v1/responses', request);

    const waits = await driveTimers(harness, [pending]);
    const response = await readJson(await pending);

    expect(response.status).toBe(502);
    expect(waits).toEqual(EQUAL_JITTER_AT_ZERO_MS);
    expect(sum(waits)).toBe(EQUAL_JITTER_AT_ZERO_TOTAL_MS);
    expect(primary.calls).toHaveLength(SENDS_BOUND);
  });

  it('keeps every wait in [cap/2, cap) at a random just below 1', async () => {
    const primary = createScriptedAdapter({ calls: unavailable(60) });
    const harness = await startBudgeted(primary, {}, () => 0.999);
    const pending = postJson(harness.client, '/v1/responses', request);

    const waits = await driveTimers(harness, [pending]);
    await readJson(await pending);

    expect(waits.length).toBeGreaterThan(5);
    waits.forEach((wait, index) => {
      expect(wait).toBeGreaterThanOrEqual(capOf(index) / 2);
      expect(wait).toBeLessThan(capOf(index));
    });
    expect(sum(waits)).toBeLessThanOrEqual(TOTAL_WAIT_MS);
    expect(sum(waits) + capOf(waits.length)).toBeGreaterThan(TOTAL_WAIT_MS);
  });

  it('honours a 429 Retry-After of 20 s, longer than retry.maxMs, while it fits: 4 waits of 20 s, then 429 rate_limited without a deferral', async () => {
    const primary = createScriptedAdapter({ calls: rateLimited(10, 20_000) });
    const harness = await startBudgeted(primary);
    const pending = postJson(harness.client, '/v1/responses', request);

    const waits = await driveTimers(harness, [pending]);
    const response = await readJson(await pending);

    expect(waits).toEqual([20_000, 20_000, 20_000, 20_000]);
    expect(primary.calls).toHaveLength(5);
    expect(response.status).toBe(429);
    expectErrorBody(response.body, { type: 'too_many_requests', code: 'rate_limited' });
    expect(response.headers['retry-after']).toBe('20');
    expect(response.headers[DEFERRED_HEADER]).toBeUndefined();
    expect(harness.timers.pending()).toEqual([]);
  });

  it('succeeds after waiting out a 429 Retry-After of 20 s', async () => {
    const primary = createScriptedAdapter({ calls: [...rateLimited(1, 20_000), ok('after the wait')] });
    const harness = await startBudgeted(primary);
    const pending = postJson(harness.client, '/v1/responses', request);

    const waits = await driveTimers(harness, [pending]);
    const response = await readJson(await pending);

    expect(waits).toEqual([20_000]);
    expect(response.status).toBe(200);
    expect(outputText(response.body)).toBe('after the wait');
    expect(response.body.momonga.attempts).toBe(2);
  });

  it('honours a Retry-After of 20 s on a 503 within the budget', async () => {
    const primary = createScriptedAdapter({ calls: [...unavailable(1, 20_000), ok('after the 503')] });
    const harness = await startBudgeted(primary);
    const pending = postJson(harness.client, '/v1/responses', request);

    const waits = await driveTimers(harness, [pending]);
    const response = await readJson(await pending);

    expect(waits).toEqual([20_000]);
    expect(response.status).toBe(200);
    expect(outputText(response.body)).toBe('after the 503');
  });

  it('returns a deferral on 429 rate_limited after one send when the only target asks for a wait longer than the whole budget', async () => {
    const primary = createScriptedAdapter({ calls: rateLimited(3, 100_000) });
    const harness = await startBudgeted(primary);

    const response = await readJson(await postJson(harness.client, '/v1/responses', request));

    expect(response.status).toBe(429);
    expectErrorBody(response.body, { type: 'too_many_requests', code: 'rate_limited' });
    expect(response.headers['retry-after']).toBe('100');
    expect(response.headers[DEFERRED_HEADER]).toBe('true');
    expect(primary.calls).toHaveLength(1);
    expect(harness.timers.pending()).toEqual([]);
  });

  it('cuts the budget short at a request deadline of 30 s: 8 waits of 29 625 ms, 9 sends, then 504 deadline_exceeded', async () => {
    const primary = createScriptedAdapter({ calls: unavailable(60) });
    const harness = await startBudgeted(primary);
    const pending = postJson(harness.client, '/v1/responses', request, { 'momonga-deadline-ms': '30000' });
    const isDeadlineTimer = (timer: PendingTimer): boolean => timer.dueAt === START_MS + 30_000 && timer.delayMs === 30_000;

    const waits = await driveTimers(harness, [pending], isDeadlineTimer);
    const response = await readJson(await pending);

    expect(response.status).toBe(504);
    expectErrorBody(response.body, { type: 'server_error', code: 'deadline_exceeded' });
    expect(waits).toEqual(EQUAL_JITTER_AT_HALF_MS.slice(0, 8));
    expect(sum(waits)).toBe(29_625);
    expect(primary.calls).toHaveLength(9);
    expect(harness.timers.pending()).toEqual([]);
  });

  it('rides out 10 failed sends over 41 625 ms within one request and answers 200 on the 11th', async () => {
    const primary = createScriptedAdapter({ calls: [...unavailable(10), ok('recovered')] });
    const harness = await startBudgeted(primary);
    const pending = postJson(harness.client, '/v1/responses', request);

    const waits = await driveTimers(harness, [pending]);
    const response = await readJson(await pending);

    expect(sum(waits)).toBe(41_625);
    expect(response.status).toBe(200);
    expect(outputText(response.body)).toBe('recovered');
    expect(primary.calls).toHaveLength(11);
    expect(response.body.momonga.attempts).toBe(11);
  });

  it('counts a hung send in the budget: a send of 80 s leaves room for 3 more waits, so 4 sends in all', async () => {
    const clock = createFakeClock(START_MS);
    const timers = createFakeTimers(clock);
    const primary = createScriptedAdapter({
      timers,
      calls: [{ delayMs: 80_000, failure: { status: 503, message: 'hung, then down' } }, ...unavailable(10)],
    });
    const harness = await startGateway({ adapters: { primary }, clock, timers, config: { retry: BUDGET, breaker: BREAKER_OUT_OF_THE_WAY } });
    const pending = postJson(harness.client, '/v1/responses', request);

    const delays = await driveTimers(harness, [pending]);
    const response = await readJson(await pending);

    expect(delays).toEqual([80_000, 375, 750, 1500]);
    expect(primary.calls).toHaveLength(4);
    expect(response.status).toBe(502);
    expectErrorBody(response.body, { type: 'server_error', code: 'upstream_error' });
    expect(clock.now() - START_MS).toBe(82_625);
  });
});

describe('the breaker never cuts the budget', () => {
  it('lets one request spend the whole 84 s on a single target under the default breaker', async () => {
    const primary = createScriptedAdapter({ calls: unavailable(60) });
    const harness = await startBudgeted(primary, { breaker: GATEWAY_CONFIG_DEFAULTS.breaker });
    const pending = postJson(harness.client, '/v1/responses', request);

    const waits = await driveTimers(harness, [pending]);
    const response = await readJson(await pending);

    expect(response.status).toBe(502);
    expectErrorBody(response.body, { type: 'server_error', code: 'upstream_error' });
    expect(waits).toEqual(EQUAL_JITTER_AT_HALF_MS);
    expect(primary.calls).toHaveLength(SENDS_AT_HALF);
  });

  it('lets two concurrent requests each spend the whole budget on the same target under the default breaker', async () => {
    const primary = createScriptedAdapter({ calls: unavailable(2 * SENDS_AT_HALF + 10) });
    const harness = await startBudgeted(primary, { breaker: GATEWAY_CONFIG_DEFAULTS.breaker });
    const first = postJson(harness.client, '/v1/responses', request);
    const second = postJson(harness.client, '/v1/responses', request);

    await driveTimers(harness, [first, second]);
    const answers = [await readJson(await first), await readJson(await second)];

    expect(answers.map((answer) => answer.status)).toEqual([502, 502]);
    for (const answer of answers) expectErrorBody(answer.body, { type: 'server_error', code: 'upstream_error' });
    expect(primary.calls).toHaveLength(2 * SENDS_AT_HALF);
  });
});

describe('the spread across targets', () => {
  const twoTargets = {
    aliases: { fast: ['primary', 'secondary'] },
    targets: { primary: { model: 'scripted-primary' }, secondary: { model: 'scripted-secondary' } },
    retry: BUDGET,
    breaker: BREAKER_OUT_OF_THE_WAY,
  };

  it('retries the first target retry.maxAttempts times, then falls back, and the last target uses what is left of the budget', async () => {
    const primary = createScriptedAdapter({ calls: unavailable(3) });
    const secondary = createScriptedAdapter({ calls: [...unavailable(4), ok('from secondary', 'scripted-secondary')] });
    const harness = await startGateway({ adapters: { primary, secondary }, config: twoTargets });
    const pending = postJson(harness.client, '/v1/responses', request);

    const waits = await driveTimers(harness, [pending]);
    const response = await readJson(await pending);

    expect(response.status).toBe(200);
    expect(outputText(response.body)).toBe('from secondary');
    expect(primary.calls).toHaveLength(3);
    expect(secondary.calls).toHaveLength(5);
    expect(waits.slice(0, 2)).toEqual([375, 750]);
    expect(waits).toHaveLength(6);
    expect(sum(waits)).toBeLessThanOrEqual(TOTAL_WAIT_MS);
    expect(response.body.momonga.fallbackFrom).toEqual(['primary']);
    expect(response.body.momonga.attempts).toBe(8);
  });

  it('falls back at once on a Retry-After above retry.maxMs when a later candidate exists, and the last target keeps retrying within the budget', async () => {
    const primary = createScriptedAdapter({ calls: rateLimited(1, 20_000) });
    const secondary = createScriptedAdapter({ calls: [...unavailable(3), ok('from secondary', 'scripted-secondary')] });
    const harness = await startGateway({ adapters: { primary, secondary }, config: twoTargets });
    const pending = postJson(harness.client, '/v1/responses', request);

    const waits = await driveTimers(harness, [pending]);
    const response = await readJson(await pending);

    expect(response.status).toBe(200);
    expect(outputText(response.body)).toBe('from secondary');
    expect(primary.calls).toHaveLength(1);
    expect(secondary.calls).toHaveLength(4);
    expect(waits.every((wait) => wait <= MAX_MS)).toBe(true);
    expect(response.body.momonga.fallbackFrom).toEqual(['primary']);
  });
});
