import { describe, expect, it } from 'vitest';
import { CC_CAPABILITIES, makeAdapter, startFake } from './cc-support.ts';
import { textReply } from './cc-compact-support.ts';
import { postJson, readJson, readSse, startGateway, userInput } from './gateway-helpers.ts';

const CONFIGURE = {
  type: 'function',
  name: 'configure',
  parameters: { type: 'object', properties: { options: { type: 'object' }, path: { type: 'string' } }, required: ['path'] },
};

const gatewayOver = async (dialect: string) => {
  const fake = await startFake({ scenario: 'tools-ok', script: [textReply('ok')] });
  const adapter = makeAdapter(fake, { schemaDialect: () => dialect, capabilities: async () => ({ ...CC_CAPABILITIES, schemaDialect: dialect }) });
  return startGateway({ adapters: { only: adapter }, config: { aliases: { fast: ['only'] }, targets: { only: { model: 'system' } } } });
};

describe('MomongaResponseExtension carries the narrowings of the render (decision a)', () => {
  it('names the tool and the parameter path on a unary response under explicit-keys', async () => {
    const { client } = await gatewayOver('explicit-keys');
    const response = await readJson(await postJson(client, '/v1/responses', { model: 'fast', input: userInput('hi'), tools: [CONFIGURE] }));
    expect(response.status).toBe(200);
    expect(response.body.momonga.schemaNarrowings).toEqual([{ tool: 'configure', path: '/properties/options' }]);
  });

  it('names them on the terminal event of a stream', async () => {
    const { client } = await gatewayOver('explicit-keys');
    const frames = await readSse(await postJson(client, '/v1/responses', { model: 'fast', input: userInput('hi'), tools: [CONFIGURE], stream: true }));
    const terminal = frames.at(-1)?.data;
    expect(terminal?.type).toBe('response.completed');
    expect(terminal?.response?.momonga?.schemaNarrowings).toEqual([{ tool: 'configure', path: '/properties/options' }]);
  });

  it('carries none under json-schema-2020-12', async () => {
    const { client } = await gatewayOver('json-schema-2020-12');
    const response = await readJson(await postJson(client, '/v1/responses', { model: 'fast', input: userInput('hi'), tools: [CONFIGURE] }));
    expect(response.status).toBe(200);
    expect(response.body.momonga.schemaNarrowings).toBeUndefined();
  });
});
