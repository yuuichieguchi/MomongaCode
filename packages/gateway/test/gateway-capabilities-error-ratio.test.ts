import { describe, expect, it } from 'vitest';
import type { Capabilities } from '@momonga/protocol';
import { createScriptedAdapter } from '@momonga/testkit';
import { chainOfServers, getJson, startGateway } from './gateway-helpers.ts';

const base: Capabilities = {
  contextWindow: 8192,
  maxOutputTokens: 1024,
  toolCalling: 'native',
  structuredOutput: 'json_schema',
  streaming: true,
  stopSequences: true,
  imageInput: true,
  imageTokens: { pixelsPerToken: 750, maxTokens: 1600, minTokens: 1 },
  parallelToolCalls: true,
  schemaDialect: 'json-schema-2020-12',
  tokenCounting: 'exact',
  usageReported: true,
  maxConcurrency: 4,
  source: 'declared',
};

const exact: Capabilities = { ...base };
const otherExact: Capabilities = { ...base, source: 'config' };
const calibrated: Capabilities = { ...base, tokenCounting: 'calibrated', tokenErrorRatio: 0.1, source: 'probed' };
const estimated: Capabilities = { ...base, tokenCounting: 'estimated', source: 'unprobed' };

const SERVERS = { exact, 'other-exact': otherExact, calibrated, estimated };

type Server = keyof typeof SERVERS;

const capabilitiesOf = async (members: readonly Server[]): Promise<Capabilities> => {
  const chain = chainOfServers(Object.fromEntries(members.map((name) => [name, { model: `model-${name}`, maxConcurrency: 4 }])));
  const { client, model } = await startGateway({
    adapters: chain.keyed(Object.fromEntries(members.map((name) => [name, createScriptedAdapter({ calls: [], capabilities: SERVERS[name] })]))),
    config: chain.config,
  });
  const response = await getJson(client, '/v1/momonga/models');
  expect(response.status).toBe(200);
  return response.body.data.find((entry: { id: string }) => entry.id === model).capabilities;
};

describe('alias tokenErrorRatio on /v1/momonga/models', () => {
  it('takes the largest sizing ratio over every target, not the first one', async () => {
    expect((await capabilitiesOf(['exact', 'calibrated'])).tokenErrorRatio).toBe(0.1);
  });

  it('sizes with the default ratio of 0.3 when another target of the alias is only estimated', async () => {
    expect((await capabilitiesOf(['calibrated', 'estimated'])).tokenErrorRatio).toBe(0.3);
    expect((await capabilitiesOf(['estimated', 'calibrated'])).tokenErrorRatio).toBe(0.3);
  });

  it('leaves the field absent when no target of the alias declares one', async () => {
    expect(await capabilitiesOf(['exact', 'other-exact'])).not.toHaveProperty('tokenErrorRatio');
  });
});
