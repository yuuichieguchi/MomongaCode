import { describe, expect, it } from 'vitest';
import { REAL_PROCESS_TEST_TIMEOUT_MS, createFakeClock, createFakeTimers, startLoopbackServer } from '@momonga/testkit';
import { postJson, readJson, userInput } from './gateway-helpers.ts';
import { PROCESS_VERSION, baseEnv, clientFor, launchGateway, makeHome, until, writeSettings } from './gateway-process-helpers.ts';

const ADVANCE_LIMIT = 50;
const DRAIN_LIMIT = 5000;

const closedOriginTarget = (origin: string) => ({
  adapter: 'chat-completions',
  provider: 'fake',
  model: 'devstral-small-2',
  baseUrl: `${origin}/v1`,
  toolCalling: 'native',
  capabilities: { contextWindow: 8192, maxOutputTokens: 1024 },
});

const ask = async (socketPath: string) => readJson(await postJson(clientFor(socketPath), '/v1/responses', { model: 'fast', input: userInput('hi') }));

describe('driving the injected fake timers of an in-process gateway until a request to a closed upstream settles', { timeout: REAL_PROCESS_TEST_TIMEOUT_MS }, () => {
  it(`settles within ${ADVANCE_LIMIT} advances of the next due timer`, async () => {
    const closed = await startLoopbackServer((_req, res) => {
      res.end();
    });
    const origin = closed.origin;
    await closed.close();
    const home = makeHome();
    writeSettings(home, { models: { aliases: { fast: ['local'] }, targets: { local: closedOriginTarget(origin) } } });
    const clock = createFakeClock(Date.now());
    const timers = createFakeTimers(clock);
    const startedAt = clock.now();
    const handle = await launchGateway({ home, env: baseEnv(home), version: PROCESS_VERSION, clock, timers, random: () => 0.5 });

    const pending = ask(handle.socketPath);
    let settled = false;
    const settle = (): void => {
      settled = true;
    };
    void pending.then(settle, settle);
    let advances = 0;
    const delaysAdvancedOver: number[] = [];
    while (!settled && advances < ADVANCE_LIMIT) {
      await until(() => settled || timers.pending().length > 0, 'a retry timer or the answer');
      const nextDue = timers.nextDueAt();
      if (!settled && nextDue !== undefined) {
        const due = timers.pending().find((timer) => timer.dueAt === nextDue);
        if (due !== undefined) delaysAdvancedOver.push(due.delayMs);
        timers.advance(Math.max(0, nextDue - clock.now()));
        advances += 1;
      }
    }

    const observed = { settled, advances, fakeElapsedMs: clock.now() - startedAt, delaysAdvancedOver: [...new Set(delaysAdvancedOver)], pendingAfter: timers.pending() };
    for (let drained = 0; !settled && drained < DRAIN_LIMIT; drained += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      const nextDue = timers.nextDueAt();
      if (!settled && nextDue !== undefined) timers.advance(Math.max(0, nextDue - clock.now()));
    }

    expect(observed.settled, JSON.stringify(observed)).toBe(true);
  });
});
