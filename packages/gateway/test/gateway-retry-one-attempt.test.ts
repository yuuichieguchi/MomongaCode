import { describe, expect, it } from 'vitest';
import { createScriptedAdapter, waitFor } from '@momonga/testkit';
import { outputText, postJson, readJson, startGateway } from './gateway-helpers.ts';
import { BREAKER_OUT_OF_THE_WAY, BUDGET, TOTAL_WAIT_MS, capOf, driveTimers, ok, request, sum, unavailable } from './retry-support.ts';

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
  return { adapter, harness, pending, settledBeforeTimePassed: settled };
};

describe('a retryable failure of the only target under retry.maxAttempts 1 is answered on the fake clock', () => {
  it.each([500, 503])('status %i: the request waits on the retry timer, and answers once the test drives it', async (status) => {
    const { adapter, harness, pending, settledBeforeTimePassed } = await asked([{ failure: { status, message: 'upstream failed' } }, ok('second answer')]);

    expect(settledBeforeTimePassed).toBe(false);
    expect(adapter.calls).toHaveLength(1);
    const waits = harness.timers.pending();
    expect(waits).toHaveLength(1);
    expect(waits[0]?.delayMs).toBeLessThanOrEqual(capOf(0));

    const delays = await driveTimers(harness, [pending]);
    const reply = await pending;

    expect(reply.status).toBe(200);
    expect(outputText(reply.body)).toBe('second answer');
    expect(reply.body.momonga.attempts).toBe(2);
    expect(delays).toHaveLength(1);
    expect(harness.timers.pending()).toEqual([]);
  });

  it('a target that never recovers is answered with its failure when the driven waits reach the wait budget, not after a real wait', async () => {
    const { adapter, harness, pending, settledBeforeTimePassed } = await asked(unavailable(64));
    const startedAt = harness.clock.now();

    expect(settledBeforeTimePassed).toBe(false);
    const delays = await driveTimers(harness, [pending]);
    const reply = await pending;

    expect(reply.status).toBe(502);
    expect(adapter.calls).toHaveLength(delays.length + 1);
    expect(sum(delays)).toBeLessThanOrEqual(TOTAL_WAIT_MS);
    expect(harness.clock.now() - startedAt).toBe(sum(delays));
    expect(harness.timers.pending()).toEqual([]);
  });
});
