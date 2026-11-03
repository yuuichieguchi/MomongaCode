import { describe, expect, it } from 'vitest';
import { createScriptedAdapter, textResponseEvents } from '@momonga/testkit';
import { postJson, readJson, startGateway, userInput } from './gateway-helpers.ts';

const reply = () => ({ events: textResponseEvents({ model: 'scripted-primary', chunks: ['ok'] }) });

describe('reasoning effort of a response request', () => {
  it('reaches the adapter as the requested effort', async () => {
    const primary = createScriptedAdapter({ calls: [reply()] });
    const { client } = await startGateway({ adapters: { primary } });

    const response = await readJson(await postJson(client, '/v1/responses', { model: 'fast', input: userInput('hi'), reasoning: { effort: 'none' } }));

    expect(response.status).toBe(200);
    expect(primary.calls[0]?.request.reasoning_effort).toBe('none');
  });

  it('is absent from the adapter request when the client asked for no effort', async () => {
    const primary = createScriptedAdapter({ calls: [reply()] });
    const { client } = await startGateway({ adapters: { primary } });

    await readJson(await postJson(client, '/v1/responses', { model: 'fast', input: userInput('hi') }));

    expect('reasoning_effort' in (primary.calls[0]?.request ?? {})).toBe(false);
  });

  it('rejects an effort the gateway does not know instead of dropping it', async () => {
    const primary = createScriptedAdapter({ calls: [reply()] });
    const { client } = await startGateway({ adapters: { primary } });

    const response = await readJson(await postJson(client, '/v1/responses', { model: 'fast', input: userInput('hi'), reasoning: { effort: 'extreme' } }));

    expect(response.status).toBe(400);
    expect(response.body.error.param).toBe('reasoning.effort');
  });
});
