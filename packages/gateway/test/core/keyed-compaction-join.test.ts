import { describe, expect, it } from 'vitest';
import { createScriptedAdapter, waitFor } from '@momonga/testkit';
import { PRIMARY, postJson, readJson, startGateway, userInput } from '../gateway-helpers.ts';

const FIRST_DEADLINE_MS = 1000;
const SECOND_DEADLINE_MS = 60_000;
const KEY = 'compaction-joined-c20';

describe('a keyed compaction joined by a second caller runs under its own bound (gateway-core-C20)', () => {
  it('answers the second caller after the first caller reached its own deadline', async () => {
    const primary = createScriptedAdapter({ calls: [], compactSummary: 'GOAL: x', compactGate: 'held' });
    const { client, timers } = await startGateway({ adapters: { [PRIMARY]: primary } });
    const body = { model: PRIMARY, input: userInput('hi') };

    const first = postJson(client, '/v1/responses/compact', body, { 'idempotency-key': KEY, 'momonga-deadline-ms': String(FIRST_DEADLINE_MS) });
    await waitFor(() => primary.compactCalls.length === 1, { description: 'the shared compaction to reach the upstream' });
    const second = postJson(client, '/v1/responses/compact', body, { 'idempotency-key': KEY, 'momonga-deadline-ms': String(SECOND_DEADLINE_MS) });
    await waitFor(() => timers.pending().some((timer) => timer.delayMs === SECOND_DEADLINE_MS), { description: 'the second caller to join with its own deadline' });

    await timers.advanceAsync(FIRST_DEADLINE_MS);
    const firstAnswer = await readJson(await first);
    expect(firstAnswer.body.error.code).toBe('deadline_exceeded');

    primary.release('held');
    const secondAnswer = await readJson(await second);
    expect(secondAnswer.status).toBe(200);
    expect(secondAnswer.body.object).toBe('response.compaction');
    expect(primary.compactCalls).toHaveLength(1);
  });
});
