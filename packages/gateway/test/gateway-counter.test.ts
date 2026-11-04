import { describe, expect, it } from 'vitest';
import { createScriptedAdapter, textResponseEvents, usageOf } from '@momonga/testkit';
import { counterForTest, getJson, postJson, readJson, readSse, startGateway, userInput } from './gateway-helpers.ts';

const aliasConfig = {
  aliases: { fast: ['primary', 'secondary'], solo: ['secondary'] },
  targets: { primary: { model: 'scripted-primary' }, secondary: { model: 'scripted-secondary' } },
  retry: { maxAttempts: 1 },
};

const answering = (model: string, text: string) => ({ events: textResponseEvents({ model, chunks: [text], usage: usageOf(9, 3) }) });

describe('the counter of the answering target on every response', () => {
  it('names the first target counter on a unary response it answered', async () => {
    const primary = createScriptedAdapter({ calls: [answering('scripted-primary', 'from primary')] });
    const secondary = createScriptedAdapter({ calls: [] });
    const { client } = await startGateway({ adapters: { primary, secondary }, config: aliasConfig });

    const response = await readJson(await postJson(client, '/v1/responses', { model: 'fast', input: userInput('hi') }));

    expect(response.status).toBe(200);
    expect(response.body.momonga).toMatchObject({ target: 'primary', counter: counterForTest('primary') });
  });

  it('names the counter on the completed event of a stream', async () => {
    const primary = createScriptedAdapter({ calls: [answering('scripted-primary', 'streamed')] });
    const secondary = createScriptedAdapter({ calls: [] });
    const { client } = await startGateway({ adapters: { primary, secondary }, config: aliasConfig });

    const frames = await readSse(await postJson(client, '/v1/responses', { model: 'fast', input: userInput('hi'), stream: true }));

    const completed = frames.find((frame) => frame.data.type === 'response.completed');
    expect(completed?.data.response.momonga).toMatchObject({ target: 'primary', counter: counterForTest('primary') });
  });

  it('names the counter of the target that answered a fallback, not that of the first target', async () => {
    const primary = createScriptedAdapter({ calls: [{ failure: { status: 503, message: 'primary is down' } }] });
    const secondary = createScriptedAdapter({ calls: [answering('scripted-secondary', 'from secondary')] });
    const { client } = await startGateway({ adapters: { primary, secondary }, config: aliasConfig });

    const response = await readJson(await postJson(client, '/v1/responses', { model: 'fast', input: userInput('hi') }));

    expect(response.body.momonga).toMatchObject({ target: 'secondary', fallbackFrom: ['primary'], counter: counterForTest('secondary') });
  });
});

describe('the counters of every target on /v1/momonga/models', () => {
  it('lists targetCounters for every target of each alias, beside the ordered targets', async () => {
    const primary = createScriptedAdapter({ calls: [] });
    const secondary = createScriptedAdapter({ calls: [] });
    const { client } = await startGateway({ adapters: { primary, secondary }, config: aliasConfig });

    const response = await getJson(client, '/v1/momonga/models');

    expect(response.status).toBe(200);
    const fast = response.body.data.find((entry: { id: string }) => entry.id === 'fast');
    const solo = response.body.data.find((entry: { id: string }) => entry.id === 'solo');
    expect(fast.targets).toEqual(['primary', 'secondary']);
    expect(fast.targetCounters).toEqual({ primary: counterForTest('primary'), secondary: counterForTest('secondary') });
    expect(solo.targets).toEqual(['secondary']);
    expect(solo.targetCounters).toEqual({ secondary: counterForTest('secondary') });
  });
});
