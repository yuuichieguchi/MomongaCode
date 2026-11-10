import { describe, expect, it } from 'vitest';
import { createScriptedAdapter, textResponseEvents, usageOf } from '@momonga/testkit';
import { counterForTest, getJson, postJson, readJson, readSse, startGateway, userInput } from './gateway-helpers.ts';

const aliasConfig = {
  chains: { 'scripted/scripted-primary': ['scripted/scripted-primary', 'scripted/scripted-secondary'], 'scripted/scripted-secondary': ['scripted/scripted-secondary'] },
  targets: { 'scripted/scripted-primary': {}, 'scripted/scripted-secondary': {} },
  retry: { maxAttempts: 1, totalWaitMs: 1 },
};

const answering = (model: string, text: string) => ({ events: textResponseEvents({ model, chunks: [text], usage: usageOf(9, 3) }) });

describe('the counter of the answering target on every response', () => {
  it('names the first target counter on a unary response it answered', async () => {
    const primary = createScriptedAdapter({ calls: [answering('scripted-primary', 'from primary')] });
    const secondary = createScriptedAdapter({ calls: [] });
    const { client } = await startGateway({ adapters: { 'scripted/scripted-primary': primary, 'scripted/scripted-secondary': secondary }, config: aliasConfig });

    const response = await readJson(await postJson(client, '/v1/responses', { model: 'scripted/scripted-primary', input: userInput('hi') }));

    expect(response.status).toBe(200);
    expect(response.body.momonga).toMatchObject({ target: 'scripted/scripted-primary', counter: counterForTest('scripted/scripted-primary') });
  });

  it('names the counter on the completed event of a stream', async () => {
    const primary = createScriptedAdapter({ calls: [answering('scripted-primary', 'streamed')] });
    const secondary = createScriptedAdapter({ calls: [] });
    const { client } = await startGateway({ adapters: { 'scripted/scripted-primary': primary, 'scripted/scripted-secondary': secondary }, config: aliasConfig });

    const frames = await readSse(await postJson(client, '/v1/responses', { model: 'scripted/scripted-primary', input: userInput('hi'), stream: true }));

    const completed = frames.find((frame) => frame.data.type === 'response.completed');
    expect(completed?.data.response.momonga).toMatchObject({ target: 'scripted/scripted-primary', counter: counterForTest('scripted/scripted-primary') });
  });

  it('names the counter of the target that answered a fallback, not that of the first target', async () => {
    const primary = createScriptedAdapter({ calls: [{ failure: { status: 503, message: 'primary is down' } }] });
    const secondary = createScriptedAdapter({ calls: [answering('scripted-secondary', 'from secondary')] });
    const { client } = await startGateway({ adapters: { 'scripted/scripted-primary': primary, 'scripted/scripted-secondary': secondary }, config: aliasConfig });

    const response = await readJson(await postJson(client, '/v1/responses', { model: 'scripted/scripted-primary', input: userInput('hi') }));

    expect(response.body.momonga).toMatchObject({ target: 'scripted/scripted-secondary', fallbackFrom: ['scripted/scripted-primary'], counter: counterForTest('scripted/scripted-secondary') });
  });
});

describe('the counters of every target on /v1/momonga/models', () => {
  it('lists the counter of every member of each chain, in the order of the chain', async () => {
    const primary = createScriptedAdapter({ calls: [] });
    const secondary = createScriptedAdapter({ calls: [] });
    const { client } = await startGateway({ adapters: { 'scripted/scripted-primary': primary, 'scripted/scripted-secondary': secondary }, config: aliasConfig });

    const response = await getJson(client, '/v1/momonga/models');

    expect(response.status).toBe(200);
    const countersOf = (id: string): Array<[string, string]> =>
      (response.body.data.find((entry: { id: string }) => entry.id === id).chain as Array<{ model: string; counter: string }>).map((member) => [member.model, member.counter]);
    expect(countersOf('scripted/scripted-primary')).toEqual([
      ['scripted/scripted-primary', counterForTest('scripted/scripted-primary')],
      ['scripted/scripted-secondary', counterForTest('scripted/scripted-secondary')],
    ]);
    expect(countersOf('scripted/scripted-secondary')).toEqual([['scripted/scripted-secondary', counterForTest('scripted/scripted-secondary')]]);
  });
});
