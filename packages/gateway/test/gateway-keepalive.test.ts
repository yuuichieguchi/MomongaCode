import { describe, expect, it } from 'vitest';
import { createScriptedAdapter, textResponseEvents, waitFor } from '@momonga/testkit';
import { postJson, startGateway, userInput } from './gateway-helpers.ts';

describe('SSE keep-alive', () => {
  it('writes comment frames every sseKeepAliveMs while the stream is idle and clears the timer at the end', async () => {
    const primary = createScriptedAdapter({
      calls: [{ events: textResponseEvents({ model: 'scripted-primary', chunks: ['slow'] }), gate: { name: 'g', afterEvents: 3 } }],
    });
    const { client, timers } = await startGateway({ adapters: { primary }, config: { sseKeepAliveMs: 2500 } });
    const response = await postJson(client, '/v1/responses', { model: 'fast', input: userInput('hi'), stream: true });
    const decoder = new TextDecoder();
    const iterator = response.body[Symbol.asyncIterator]();
    let received = decoder.decode((await iterator.next()).value as Uint8Array);
    await waitFor(() => timers.pending().some((timer) => timer.delayMs === 2500), { description: 'keep-alive timer' });
    timers.advance(2500);
    while (!received.includes(': keep-alive\n\n')) received += decoder.decode((await iterator.next()).value as Uint8Array);
    expect(received).toContain(': keep-alive\n\n');

    primary.release('g');
    for (let step = await iterator.next(); step.done !== true; step = await iterator.next()) received += decoder.decode(step.value as Uint8Array);
    expect(received).toContain('event: response.completed');
    expect(timers.pending()).toEqual([]);
  });
});
