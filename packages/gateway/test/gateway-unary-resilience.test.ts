import { describe, expect, it } from 'vitest';
import type { AdapterCompactResult, AdapterContext, CountTokensResult } from '@momonga/protocol';
import { ScriptedUpstreamError, createScriptedAdapter, waitFor } from '@momonga/testkit';
import { expectErrorBody, postJson, readJson, startGateway, userInput } from './gateway-helpers.ts';
import { BREAKER_OUT_OF_THE_WAY, BUDGET, DEFERRED_HEADER, driveTimers, sum } from './retry-support.ts';

const compactBody = { model: 'scripted/scripted-primary', input: userInput('summarize') };
const countBody = { model: 'scripted/scripted-primary', input: userInput('count') };

const failing = (status: number, retryAfterMs?: number) => {
  const base = createScriptedAdapter({ calls: [] });
  const attempts = { compact: 0, count: 0 };
  const failure = new ScriptedUpstreamError({ status, message: 'upstream said no', ...(retryAfterMs === undefined ? {} : { retryAfterMs }) });
  return {
    attempts,
    adapter: {
      ...base,
      compact: async (): Promise<AdapterCompactResult> => {
        attempts.compact += 1;
        throw failure;
      },
      countTokens: async (): Promise<CountTokensResult> => {
        attempts.count += 1;
        throw failure;
      },
    },
  };
};

describe('momonga-deadline-ms on unary endpoints', () => {
  it.each([
    ['/v1/responses/compact', compactBody],
    ['/v1/momonga/count_tokens', countBody],
  ])('rejects a malformed deadline on %s', async (path, body) => {
    const { adapter } = failing(503);
    const { client } = await startGateway({ adapters: { 'scripted/scripted-primary': adapter } });
    const response = await readJson(await postJson(client, path, body, { 'momonga-deadline-ms': 'soon' }));
    expect(response.status).toBe(400);
    expectErrorBody(response.body, { type: 'invalid_request', code: 'invalid_deadline' });
  });

  it.each([
    ['/v1/responses/compact', compactBody],
    ['/v1/momonga/count_tokens', countBody],
  ])('stops retrying %s with 504 when the next wait passes the deadline', async (path, body) => {
    const { adapter, attempts } = failing(429, 5000);
    const { client, timers } = await startGateway({ adapters: { 'scripted/scripted-primary': adapter } });
    const response = await readJson(await postJson(client, path, body, { 'momonga-deadline-ms': '1000' }));
    expect(response.status).toBe(504);
    expectErrorBody(response.body, { type: 'server_error', code: 'deadline_exceeded' });
    expect(attempts.compact + attempts.count).toBe(1);
    expect(timers.pending()).toEqual([]);
  });

  it('aborts a hung compaction at the deadline', async () => {
    const base = createScriptedAdapter({ calls: [] });
    let seen: AbortSignal | undefined;
    const adapter = {
      ...base,
      compact: (_request: unknown, ctx: AdapterContext): Promise<AdapterCompactResult> => {
        seen = ctx.signal;
        return new Promise((_, reject) => ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason)));
      },
    };
    const { client, timers } = await startGateway({ adapters: { 'scripted/scripted-primary': adapter } });
    const pending = postJson(client, '/v1/responses/compact', compactBody, { 'momonga-deadline-ms': '1000' });
    await waitFor(() => seen !== undefined && timers.pending().some((timer) => timer.delayMs === 1000), { description: 'deadline timer' });
    timers.advance(1000);
    const response = await readJson(await pending);
    expect(response.status).toBe(504);
    expect(timers.pending()).toEqual([]);
  });
});

describe('count_tokens uses the breaker and admission gate', () => {
  it('opens the breaker after a failing request, and a later request on the only target still reaches the adapter', async () => {
    const { adapter, attempts } = failing(503);
    const { client } = await startGateway({
      adapters: { 'scripted/scripted-primary': adapter },
      config: { retry: { maxAttempts: 1, totalWaitMs: 1 }, breaker: { failureThreshold: 1, openMs: 30_000 } },
    });
    const first = await readJson(await postJson(client, '/v1/momonga/count_tokens', countBody));
    expect(first.status).toBe(502);
    const second = await readJson(await postJson(client, '/v1/momonga/count_tokens', countBody));
    expect(second.status).toBe(502);
    expectErrorBody(second.body, { type: 'server_error', code: 'upstream_error' });
    expect(attempts.count).toBe(2);
  });

  it('queues behind the target concurrency limit', async () => {
    const base = createScriptedAdapter({ calls: [] });
    let release: (() => void) | undefined;
    let running = 0;
    let peak = 0;
    let started = 0;
    const adapter = {
      ...base,
      countTokens: async (): Promise<CountTokensResult> => {
        running += 1;
        started += 1;
        peak = Math.max(peak, running);
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        running -= 1;
        return { input_tokens: 3, method: 'exact', error_bound: 0, error_shape: { ratio: 0, minimum: 0 } };
      },
    };
    const { client } = await startGateway({
      adapters: { 'scripted/scripted-primary': adapter },
      config: { targets: { 'scripted/scripted-primary': { maxConcurrency: 1 } } },
    });
    const one = postJson(client, '/v1/momonga/count_tokens', countBody);
    await waitFor(() => running === 1);
    const two = postJson(client, '/v1/momonga/count_tokens', countBody);
    release?.();
    await waitFor(() => started === 2, { description: 'second admitted after first finished' });
    release?.();
    expect((await readJson(await one)).status).toBe(200);
    expect((await readJson(await two)).status).toBe(200);
    expect(peak).toBe(1);
  });
});

describe('the retry budget on unary endpoints', () => {
  const EQUAL_JITTER_AT_HALF_MS = [375, 750, 1500, 3000, 6000, ...Array.from({ length: 12 }, () => 6000)];

  it.each([
    ['/v1/responses/compact', compactBody, 'compact'],
    ['/v1/momonga/count_tokens', countBody, 'count'],
  ] as const)('spends the whole 84 s budget on %s: 17 equal-jitter waits, 18 calls, then 502', async (path, body, kind) => {
    const { adapter, attempts } = failing(503);
    const harness = await startGateway({ adapters: { 'scripted/scripted-primary': adapter }, config: { retry: { ...BUDGET, maxAttempts: 100 }, breaker: BREAKER_OUT_OF_THE_WAY } });
    const pending = postJson(harness.client, path, body);

    const waits = await driveTimers(harness, [pending]);
    const response = await readJson(await pending);

    expect(waits).toEqual(EQUAL_JITTER_AT_HALF_MS);
    expect(sum(waits)).toBe(83_625);
    expect(attempts[kind]).toBe(18);
    expect(response.status).toBe(502);
    expectErrorBody(response.body, { type: 'server_error', code: 'upstream_error' });
  });

  it.each([
    ['/v1/responses/compact', compactBody, 'compact'],
    ['/v1/momonga/count_tokens', countBody, 'count'],
  ] as const)('returns a deferral on %s when a 429 asks for longer than the whole budget', async (path, body, kind) => {
    const { adapter, attempts } = failing(429, 100_000);
    const harness = await startGateway({ adapters: { 'scripted/scripted-primary': adapter }, config: { retry: BUDGET, breaker: BREAKER_OUT_OF_THE_WAY } });

    const response = await readJson(await postJson(harness.client, path, body));

    expect(response.status).toBe(429);
    expect(response.headers['retry-after']).toBe('100');
    expect(response.headers[DEFERRED_HEADER]).toBe('true');
    expect(attempts[kind]).toBe(1);
  });
});
