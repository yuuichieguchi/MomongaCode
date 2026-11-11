import { describe, expect, it } from 'vitest';
import { createScriptedAdapter, textResponseEvents } from '@momonga/testkit';
import { postJson, sseIterator, startGateway, userInput } from './gateway-helpers.ts';
import { bigTextEvents } from './gateway-support.ts';

const READER_STALL_MS = 30_000;
const BIG_CHUNKS = 200;
const BIG_CHUNK_BYTES = 100_000;

const textCall = (text: string) => ({ events: textResponseEvents({ model: 'scripted-primary', chunks: [text] }) });

describe('a client that stops reading', () => {
  it('releases the target slot of a stalled unkeyed SSE stream once the reader-stall bound passes', async () => {
    const adapter = createScriptedAdapter({ calls: [{ events: bigTextEvents(BIG_CHUNKS, BIG_CHUNK_BYTES) }, textCall('after')] });
    const harness = await startGateway({ adapters: { 'scripted/scripted-primary': adapter }, config: { targets: { 'scripted/scripted-primary': { maxConcurrency: 1 } } } });
    const first = sseIterator(await postJson(harness.client, '/v1/responses', { model: 'scripted/scripted-primary', input: userInput('hi'), stream: true }));
    await first.next();
    await harness.timers.advanceAsync(READER_STALL_MS);
    const second = sseIterator(await postJson(harness.client, '/v1/responses', { model: 'scripted/scripted-primary', input: userInput('hi'), stream: true }));
    const types: string[] = [];
    for (let step = await second.next(); step.done !== true; step = await second.next()) types.push(step.value.data.type as string);
    expect(types).toContain('response.completed');
    expect(adapter.calls).toHaveLength(2);
    await first.return?.();
  });
});
