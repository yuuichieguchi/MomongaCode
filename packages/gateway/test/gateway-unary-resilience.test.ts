import { describe, expect, it } from 'vitest';
import type { AdapterCompactResult, AdapterContext, CountTokensResult } from '@momonga/protocol';
import { ScriptedUpstreamError, createScriptedAdapter, waitFor } from '@momonga/testkit';
import { expectErrorBody, postJson, readJson, startGateway, userInput } from './gateway-helpers.ts';

const compactBody = { model: 'fast', input: userInput('summarize') };
const countBody = { model: 'fast', input: userInput('count') };

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
    const { client } = await startGateway({ adapters: { primary: adapter } });
    const response = await readJson(await postJson(client, path, body, { 'momonga-deadline-ms': 'soon' }));
    expect(response.status).toBe(400);
    expectErrorBody(response.body, { type: 'invalid_request', code: 'invalid_deadline' });
  });

  it.each([
    ['/v1/responses/compact', compactBody],
    ['/v1/momonga/count_tokens', countBody],
  ])('stops retrying %s with 504 when the next wait passes the deadline', async (path, body) => {
    const { adapter, attempts } = failing(429, 5000);
    const { client, timers } = await startGateway({ adapters: { primary: adapter } });
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
    const { client, timers } = await startGateway({ adapters: { primary: adapter } });
    const pending = postJson(client, '/v1/responses/compact', compactBody, { 'momonga-deadline-ms': '1000' });
    await waitFor(() => seen !== undefined && timers.pending().some((timer) => timer.delayMs === 1000), { description: 'deadline timer' });
    timers.advance(1000);
    const response = await readJson(await pending);
    expect(response.status).toBe(504);
    expect(timers.pending()).toEqual([]);
  });
});

describe('count_tokens uses the breaker and admission gate', () => {
  it('opens the breaker after repeated upstream failures and then refuses without calling the adapter', async () => {
    const { adapter, attempts } = failing(503);
    const { client } = await startGateway({
      adapters: { primary: adapter },
      config: { retry: { maxAttempts: 1 }, breaker: { failureThreshold: 1, openMs: 30_000 } },
    });
    const first = await readJson(await postJson(client, '/v1/momonga/count_tokens', countBody));
    expect(first.status).toBe(502);
    const second = await readJson(await postJson(client, '/v1/momonga/count_tokens', countBody));
    expect(second.status).toBe(503);
    expectErrorBody(second.body, { type: 'server_error', code: 'all_targets_unavailable' });
    expect(attempts.count).toBe(1);
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
      adapters: { primary: adapter },
      config: { targets: { primary: { model: 'scripted-primary', maxConcurrency: 1 } } },
    });
    const one = postJson(client, '/v1/momonga/count_tokens', countBody);
    await waitFor(() => running === 1);
    const two = postJson(client, '/v1/momonga/count_tokens', countBody);
    await new Promise((resolve) => setImmediate(resolve));
    expect(running).toBe(1);
    release?.();
    await waitFor(() => started === 2, { description: 'second admitted after first finished' });
    release?.();
    expect((await readJson(await one)).status).toBe(200);
    expect((await readJson(await two)).status).toBe(200);
    expect(peak).toBe(1);
  });
});
