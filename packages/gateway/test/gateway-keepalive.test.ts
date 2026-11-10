import { describe, expect, it } from 'vitest';
import { createScriptedAdapter, textResponseEvents, waitFor } from '@momonga/testkit';
import { postJson, startGateway, userInput } from './gateway-helpers.ts';

describe('SSE keep-alive', () => {
  it('writes comment frames every sseKeepAliveMs while the stream is idle after its first output, and clears the timer at the end', async () => {
    const primary = createScriptedAdapter({
      calls: [{ events: textResponseEvents({ model: 'scripted-primary', chunks: ['slow'] }), gate: { name: 'g', afterEvents: 5 } }],
    });
    const { client, timers } = await startGateway({ adapters: { 'scripted/scripted-primary': primary }, config: { sseKeepAliveMs: 2500 } });
    const pending = postJson(client, '/v1/responses', { model: 'scripted/scripted-primary', input: userInput('hi'), stream: true });
    await waitFor(() => primary.calls[0]?.emitted === 5 && timers.pending().some((timer) => timer.delayMs === 2500), { description: 'keep-alive timer' });
    timers.advance(2500);
    const response = await pending;
    const decoder = new TextDecoder();
    const iterator = response.body[Symbol.asyncIterator]();
    let received = '';
    while (!received.includes(': keep-alive\n\n')) received += decoder.decode((await iterator.next()).value as Uint8Array);
    expect(received).toContain(': keep-alive\n\n');
    expect(received).toContain('event: response.output_text.delta');

    primary.release('g');
    for (let step = await iterator.next(); step.done !== true; step = await iterator.next()) received += decoder.decode(step.value as Uint8Array);
    expect(received).toContain('event: response.completed');
    expect(timers.pending()).toEqual([]);
  });
});
