import { describe, expect, it } from 'vitest';
import type { Capabilities } from '@momonga/protocol';
import { createScriptedAdapter } from '@momonga/testkit';
import { getJson, startGateway } from './gateway-helpers.ts';

const base: Capabilities = {
  contextWindow: 8192,
  maxOutputTokens: 1024,
  toolCalling: 'native',
  structuredOutput: 'json_schema',
  streaming: true,
  stopSequences: true,
  imageInput: true,
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

const target = (name: string) => ({ model: `model-${name}`, maxConcurrency: 4 });

const capabilitiesOf = async (alias: string): Promise<Capabilities> => {
  const { client } = await startGateway({
    adapters: {
      exact: createScriptedAdapter({ calls: [], capabilities: exact }),
      otherExact: createScriptedAdapter({ calls: [], capabilities: otherExact }),
      calibrated: createScriptedAdapter({ calls: [], capabilities: calibrated }),
      estimated: createScriptedAdapter({ calls: [], capabilities: estimated }),
    },
    config: {
      aliases: {
        exactThenCalibrated: ['exact', 'calibrated'],
        calibratedThenEstimated: ['calibrated', 'estimated'],
        estimatedThenCalibrated: ['estimated', 'calibrated'],
        exactOnly: ['exact', 'otherExact'],
      },
      targets: { exact: target('exact'), otherExact: target('otherExact'), calibrated: target('calibrated'), estimated: target('estimated') },
    },
  });
  const response = await getJson(client, '/v1/momonga/models');
  expect(response.status).toBe(200);
  return response.body.data.find((entry: { id: string }) => entry.id === alias).capabilities;
};

describe('alias tokenErrorRatio on /v1/momonga/models', () => {
  it('takes the largest sizing ratio over every target, not the first one', async () => {
    expect((await capabilitiesOf('exactThenCalibrated')).tokenErrorRatio).toBe(0.1);
  });

  it('sizes with the default ratio of 0.3 when another target of the alias is only estimated', async () => {
    expect((await capabilitiesOf('calibratedThenEstimated')).tokenErrorRatio).toBe(0.3);
    expect((await capabilitiesOf('estimatedThenCalibrated')).tokenErrorRatio).toBe(0.3);
  });

  it('leaves the field absent when no target of the alias declares one', async () => {
    expect(await capabilitiesOf('exactOnly')).not.toHaveProperty('tokenErrorRatio');
  });
});
