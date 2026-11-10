import { describe, expect, it } from 'vitest';
import { createFakeClock, createFakeTimers, createScriptedAdapter } from '@momonga/testkit';
import { START_MS, expectErrorBody, outputText, postJson, readJson, startGateway } from './gateway-helpers.ts';
import { BREAKER_OUT_OF_THE_WAY, BUDGET, TOTAL_WAIT_MS, driveTimers, ok, request, sum } from './retry-support.ts';

const startTwo = async (primaryCalls: Parameters<typeof createScriptedAdapter>[0]['calls'], secondaryCalls: Parameters<typeof createScriptedAdapter>[0]['calls']) => {
  const clock = createFakeClock(START_MS);
  const timers = createFakeTimers(clock);
  const primary = createScriptedAdapter({ timers, calls: primaryCalls });
  const secondary = createScriptedAdapter({ timers, calls: secondaryCalls });
  const harness = await startGateway({
    adapters: { 'scripted/scripted-primary': primary, 'scripted/scripted-secondary': secondary },
    clock,
    timers,
    config: {
      chains: { 'scripted/scripted-primary': ['scripted/scripted-primary', 'scripted/scripted-secondary'] },
      targets: { 'scripted/scripted-primary': {}, 'scripted/scripted-secondary': {} },
      retry: BUDGET,
      breaker: BREAKER_OUT_OF_THE_WAY,
    },
  });
  const scriptedDelaysMs = sum([...primaryCalls, ...secondaryCalls].map((call) => ('delayMs' in call ? (call.delayMs ?? 0) : 0)));
  const send = async () => {
    const pending = postJson(harness.client, '/v1/responses', request);
    await driveTimers(harness, [pending], undefined, TOTAL_WAIT_MS + scriptedDelaysMs);
    return readJson(await pending);
  };
  return { primary, secondary, send };
};

describe('the budget bounds waits; the first send on a fallback target needs none (W1)', () => {
  it('falls back and sends once to the secondary after the primary hung past the budget and then answered 503', async () => {
    const { primary, secondary, send } = await startTwo(
      [{ delayMs: 90_000, failure: { status: 503, message: 'hung, then down' } }],
      [ok('from secondary', 'scripted-secondary')],
    );

    const response = await send();

    expect(response.status).toBe(200);
    expect(outputText(response.body)).toBe('from secondary');
    expect(response.body.momonga.fallbackFrom).toEqual(['scripted/scripted-primary']);
    expect(primary.calls).toHaveLength(1);
    expect(secondary.calls).toHaveLength(1);
  });

  it('falls back after the primary hung on all of its retry.maxAttempts sends', async () => {
    const hung = (index: number) => ({ delayMs: 30_000, failure: { status: 503, message: `hung ${index}` } });
    const { primary, secondary, send } = await startTwo([hung(1), hung(2), hung(3)], [ok('from secondary', 'scripted-secondary')]);

    const response = await send();

    expect(response.status).toBe(200);
    expect(outputText(response.body)).toBe('from secondary');
    expect(primary.calls).toHaveLength(3);
    expect(secondary.calls).toHaveLength(1);
  });

  it('does not retry on the secondary when its next wait would pass the spent budget', async () => {
    const { primary, secondary, send } = await startTwo(
      [{ delayMs: 90_000, failure: { status: 503, message: 'hung, then down' } }],
      [{ failure: { status: 503, message: 'secondary down' } }, ok('never sent', 'scripted-secondary')],
    );

    const response = await send();

    expect(response.status).toBe(502);
    expectErrorBody(response.body, { type: 'server_error', code: 'upstream_error' });
    expect(response.body.error.message).toContain('secondary down');
    expect(primary.calls).toHaveLength(1);
    expect(secondary.calls).toHaveLength(1);
  });
});
