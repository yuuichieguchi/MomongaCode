import { describe, expect, it } from 'vitest';
import { createScriptedAdapter, textResponseEvents } from '@momonga/testkit';
import { postJson, readJson, startGateway, userInput } from './gateway-helpers.ts';
import { incompleteEvents } from './gateway-support.ts';

describe('which responses are stored', () => {
  it('chains from a stored incomplete response', async () => {
    const primary = createScriptedAdapter({
      calls: [{ events: incompleteEvents('cut off') }, { events: textResponseEvents({ model: 'scripted-primary', chunks: ['next'] }) }],
    });
    const { client } = await startGateway({ adapters: { primary } });
    const first = await readJson(await postJson(client, '/v1/responses', { model: 'fast', input: userInput('q1'), store: true }));
    expect(first.body.status).toBe('incomplete');
    const second = await readJson(
      await postJson(client, '/v1/responses', { model: 'fast', input: userInput('q2'), previous_response_id: first.body.id }),
    );
    expect(second.status).toBe(200);
    expect(primary.calls[1]?.request.input).toEqual([...userInput('q1'), ...first.body.output, ...userInput('q2')]);
  });

  it('does not store a failed response', async () => {
    const primary = createScriptedAdapter({
      calls: [{ events: textResponseEvents({ model: 'scripted-primary', chunks: ['a', 'b'] }).slice(0, 5), failure: { status: 503, message: 'x' } }],
    });
    const { client } = await startGateway({ adapters: { primary } });
    const frames = await postJson(client, '/v1/responses', { model: 'fast', input: userInput('q1'), store: true, stream: true });
    const text = await frames.text();
    const id = /"id":"(resp_[^"]+)"/.exec(text)?.[1] ?? '';
    const followUp = await readJson(
      await postJson(client, '/v1/responses', { model: 'fast', input: userInput('q2'), previous_response_id: id }),
    );
    expect(followUp.status).toBe(404);
  });
});
