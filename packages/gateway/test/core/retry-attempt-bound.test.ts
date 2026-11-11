import { describe, expect, it } from 'vitest';
import type { AdapterCompactResult } from '@momonga/protocol';
import { ScriptedUpstreamError, createScriptedAdapter } from '@momonga/testkit';
import { postJson, readJson, startGateway, userInput } from '../gateway-helpers.ts';
import { BREAKER_OUT_OF_THE_WAY, driveTimers } from '../retry-support.ts';

const failingCompact = (status: number, retryAfterMs?: number) => {
  const base = createScriptedAdapter({ calls: [] });
  const sends = { count: 0 };
  return {
    sends,
    adapter: {
      ...base,
      compact: async (): Promise<AdapterCompactResult> => {
        sends.count += 1;
        throw new ScriptedUpstreamError({ status, message: `failure ${sends.count}`, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) });
      },
    },
  };
};

const MAX_ATTEMPTS = 3;

describe('retry.maxAttempts bounds the sends to one model on every path', () => {
  it('sends a sole model that answers 500 exactly maxAttempts times and reports its last failure', async () => {
    const { adapter, sends } = failingCompact(500);
    const harness = await startGateway({
      adapters: { 'scripted/scripted-primary': adapter },
      config: { retry: { maxAttempts: MAX_ATTEMPTS, totalWaitMs: 84_000 }, breaker: BREAKER_OUT_OF_THE_WAY },
    });
    const pending = postJson(harness.client, '/v1/responses/compact', { model: 'scripted/scripted-primary', input: userInput('summarize') });
    await driveTimers(harness, [pending]);
    const response = await readJson(await pending);
    expect(sends.count).toBe(MAX_ATTEMPTS);
    expect(response.status).toBeGreaterThanOrEqual(500);
    expect(JSON.stringify(response.body)).toContain(`failure ${MAX_ATTEMPTS}`);
  });

  it('sends the last member of a chain exactly maxAttempts times', async () => {
    const first = failingCompact(500);
    const last = failingCompact(500);
    const harness = await startGateway({
      adapters: { 'scripted/model-a': first.adapter, 'scripted/model-b': last.adapter },
      config: {
        targets: { 'scripted/model-a': {}, 'scripted/model-b': {} },
        chains: { 'scripted/model-a': ['scripted/model-a', 'scripted/model-b'] },
        retry: { maxAttempts: MAX_ATTEMPTS, totalWaitMs: 84_000 },
        breaker: BREAKER_OUT_OF_THE_WAY,
      },
    });
    const pending = postJson(harness.client, '/v1/responses/compact', { model: 'scripted/model-a', input: userInput('summarize') });
    await driveTimers(harness, [pending]);
    const response = await readJson(await pending);
    expect(first.sends.count).toBe(MAX_ATTEMPTS);
    expect(last.sends.count).toBe(MAX_ATTEMPTS);
    expect(JSON.stringify(response.body)).toContain(`failure ${MAX_ATTEMPTS}`);
  });

  it('ends a 429 whose retry-after passes the time bound with that last failure', async () => {
    const { adapter, sends } = failingCompact(429, 5000);
    const harness = await startGateway({
      adapters: { 'scripted/scripted-primary': adapter },
      config: { retry: { maxAttempts: MAX_ATTEMPTS, totalWaitMs: 1000 }, breaker: BREAKER_OUT_OF_THE_WAY },
    });
    const pending = postJson(harness.client, '/v1/responses/compact', { model: 'scripted/scripted-primary', input: userInput('summarize') });
    await driveTimers(harness, [pending]);
    const response = await readJson(await pending);
    expect(sends.count).toBe(1);
    expect(response.status).toBe(429);
    expect(JSON.stringify(response.body)).toContain('failure 1');
  });
});
