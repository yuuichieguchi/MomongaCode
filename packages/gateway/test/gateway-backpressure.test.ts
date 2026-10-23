import { describe, expect, it } from 'vitest';
import { createScriptedAdapter, waitFor } from '@momonga/testkit';
import { postJson, readJson, readSse, sseIterator, startGateway, userInput } from './gateway-helpers.ts';
import { bigTextEvents } from './gateway-support.ts';

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('streaming backpressure', () => {
  it('does not pull the adapter far ahead of a slow reader on a non-idempotent stream', async () => {
    const primary = createScriptedAdapter({ calls: [{ events: bigTextEvents(200, 100_000) }] });
    const { client } = await startGateway({ adapters: { primary } });
    const response = await postJson(client, '/v1/responses', { model: 'fast', input: userInput('hi'), stream: true });
    const frames = sseIterator(response);
    await frames.next();
    await pause(300);
    expect(primary.calls[0]?.emitted).toBeLessThan(60);
    let count = 1;
    for (let step = await frames.next(); step.done !== true; step = await frames.next()) count += 1;
    expect(count).toBeGreaterThan(200);
  });
});

describe('idempotent frame cap', () => {
  const body = { model: 'fast', input: userInput('hi'), stream: true };
  const key = { 'idempotency-key': 'cap-1' };

  it('finishes the leader, does not persist the result, and rejects late joiners with 409 idempotency_key_in_progress', async () => {
    const events = bigTextEvents(10, 1000);
    const primary = createScriptedAdapter({
      calls: [{ events, gate: { name: 'g', afterEvents: 12 } }, { events: bigTextEvents(10, 1000) }],
    });
    const { client } = await startGateway({ adapters: { primary }, config: { limits: { maxIdempotencyFrameBytes: 4000 } } });
    const leaderResponse = await postJson(client, '/v1/responses', body, key);
    const leader = sseIterator(leaderResponse);
    for (let index = 0; index < 8; index += 1) await leader.next();
    await waitFor(() => primary.calls[0]?.emitted === 12);

    const joiner = await readJson(await postJson(client, '/v1/responses', body, key));
    expect(joiner.status).toBe(409);
    expect(joiner.body.error.code).toBe('idempotency_key_in_progress');

    primary.release('g');
    let frames = 8;
    for (let step = await leader.next(); step.done !== true; step = await leader.next()) frames += 1;
    expect(frames).toBe(events.length);

    const again = await readSse(await postJson(client, '/v1/responses', body, key));
    expect(again.at(-1)?.data.type).toBe('response.completed');
    expect(primary.calls).toHaveLength(2);
  });
});
