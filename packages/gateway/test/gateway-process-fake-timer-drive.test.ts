import { describe, expect, it, vi } from 'vitest';
import { BODY_PURGE_INTERVAL_MS } from '@momonga/observability';
import { REAL_PROCESS_TEST_TIMEOUT_MS, createFakeClock, createFakeTimers, driveFakeTime, startLoopbackServer } from '@momonga/testkit';
import { GATEWAY_CONFIG_DEFAULTS } from '../src/defaults.ts';
import { postJson, readJson, userInput } from './gateway-helpers.ts';
import { PROCESS_VERSION, baseEnv, clientFor, launchGateway, makeHome, writeSettings, modelsOf, notTheRoleTick } from './gateway-process-helpers.ts';
import { FIRST_GENERATION } from '@momonga/foundation';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const RETRY_BUDGET_MS = GATEWAY_CONFIG_DEFAULTS.retry.totalWaitMs;

const closedOriginTarget = (origin: string) => ({
  adapter: 'chat-completions',
  model: 'devstral-small-2',
  baseUrl: `${origin}/v1`,
  toolCalling: 'native',
  capabilities: { contextWindow: 8192, maxOutputTokens: 1024 },
});

const ask = async (socketPath: string) => readJson(await postJson(clientFor(socketPath), '/v1/responses', { model: 'local/devstral-small-2', input: userInput('hi') }));

const launchAgainstClosedUpstream = async () => {
  const closed = await startLoopbackServer((_req, res) => {
    res.end();
  });
  const origin = closed.origin;
  await closed.close();
  const home = makeHome();
  writeSettings(home, { models: modelsOf({ local: closedOriginTarget(origin) }) });
  const clock = createFakeClock(Date.now());
  const timers = createFakeTimers(clock);
  const startedAt = clock.now();
  const handle = await launchGateway({ generation: FIRST_GENERATION, home, env: baseEnv(home), version: PROCESS_VERSION, clock, timers, random: () => 0.5 });
  return { clock, timers, startedAt, handle };
};

const settledFlag = (promise: Promise<unknown>): (() => boolean) => {
  let settled = false;
  const settle = (): void => {
    settled = true;
  };
  void promise.then(settle, settle);
  return () => settled;
};

describe('driving the injected fake timers of an in-process gateway whose body purge is armed on them', () => {
  it('settles a request to a closed upstream within the retry budget horizon and leaves the purge timer unfired', async () => {
    const { clock, timers, startedAt, handle } = await launchAgainstClosedUpstream();

    const pending = ask(handle.socketPath);
    const settled = settledFlag(pending);
    await driveFakeTime(timers, { done: settled, considered: notTheRoleTick, horizonAt: startedAt + RETRY_BUDGET_MS, description: 'the answer to a request against a closed upstream' });
    const response = await pending;

    expect(response.body.error.code).toBe('provider_unavailable');
    expect(clock.now() - startedAt).toBeLessThanOrEqual(RETRY_BUDGET_MS);
    expect(timers.pending()).toContainEqual(expect.objectContaining({ delayMs: BODY_PURGE_INTERVAL_MS, dueAt: startedAt + BODY_PURGE_INTERVAL_MS }));
  });

  it('fails fast, naming the purge timer, when its predicate never holds', async () => {
    const { timers, startedAt, handle } = await launchAgainstClosedUpstream();
    const settled = settledFlag(ask(handle.socketPath));

    await expect(driveFakeTime(timers, { done: () => false, considered: notTheRoleTick, horizonAt: startedAt + RETRY_BUDGET_MS, deadlineMs: 3000, description: 'a condition that never holds' })).rejects.toThrow(
      new RegExp(`a condition that never holds not met within ${RETRY_BUDGET_MS} fake ms: the real-time deadline of 3000 ms passed; pending timers .*"delayMs":${BODY_PURGE_INTERVAL_MS}`),
    );
    expect(settled()).toBe(true);
  });
});
