import { describe, expect, it } from 'vitest';
import { waitFor } from '@momonga/testkit';
import { CC_CAPABILITIES, makeAdapter, startFake } from './cc-support.ts';
import { postJson, readJson, startGateway, userInput } from './gateway-helpers.ts';

const textReply = { kind: 'stream' as const, chunks: [{ delta: { role: 'assistant', content: 'recovered' } }, { delta: {}, finishReason: 'stop' }] };

describe('chat-completions retry before any output', () => {
  it('retries when the upstream answers 200 and then ends without sending an event', async () => {
    const fake = await startFake({ scenario: 'tools-ok', script: [{ kind: 'raw-sse', events: [] }, textReply] });
    const adapter = makeAdapter(fake, { toolCalling: () => 'native', capabilities: async () => CC_CAPABILITIES });
    const { client, timers } = await startGateway({ adapters: { fm: adapter }, config: { aliases: { fast: ['fm'] }, targets: { fm: { model: 'system' } } } });
    const pending = postJson(client, '/v1/responses', { model: 'fast', input: userInput('hi') });
    await waitFor(() => timers.pending().length > 0, { description: 'retry timer' });
    timers.advance(10_000);
    const response = await readJson(await pending);
    expect(response.status).toBe(200);
    expect(response.body.status).toBe('completed');
    expect(response.body.momonga.attempts).toBe(2);
  });
});
