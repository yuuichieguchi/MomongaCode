import { describe, expect, it } from 'vitest';
import { createScriptedAdapter, waitFor } from '@momonga/testkit';
import { outputText, postJson, readJson, startGateway } from './gateway-helpers.ts';
import { BREAKER_OUT_OF_THE_WAY, BUDGET, ok, request, unavailable } from './retry-support.ts';

const ONE_ATTEMPT = { ...BUDGET, maxAttempts: 1 };

const asked = async (calls: Parameters<typeof createScriptedAdapter>[0]['calls']) => {
  const adapter = createScriptedAdapter({ calls });
  const harness = await startGateway({ adapters: { 'scripted/scripted-primary': adapter }, config: { retry: ONE_ATTEMPT, breaker: BREAKER_OUT_OF_THE_WAY } });
  let settled = false;
  const pending = postJson(harness.client, '/v1/responses', request)
    .then(readJson)
    .finally(() => {
      settled = true;
    });
  await waitFor(() => settled || harness.timers.pending().length > 0, { description: 'the answer or the retry wait' });
  return { adapter, harness, pending };
};

describe('a retryable failure of the only target under retry.maxAttempts 1 is sent once', () => {
  it.each([500, 503])('status %i: the request is answered with the failure after one send, with no retry wait', async (status) => {
    const { adapter, harness, pending } = await asked([{ failure: { status, message: 'upstream failed' } }, ok('second answer')]);
    const reply = await pending;

    expect(reply.status).toBeGreaterThanOrEqual(500);
    expect(adapter.calls).toHaveLength(1);
    expect(harness.timers.pending()).toEqual([]);
  });

  it('a target that never recovers is sent once and answered with its failure without a wait', async () => {
    const { adapter, harness, pending } = await asked(unavailable(64));
    const startedAt = harness.clock.now();
    const reply = await pending;

    expect(reply.status).toBe(502);
    expect(adapter.calls).toHaveLength(1);
    expect(harness.clock.now()).toBe(startedAt);
    expect(harness.timers.pending()).toEqual([]);
  });
});
