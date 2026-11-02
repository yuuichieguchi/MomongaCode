import { describe, expect, it } from 'vitest';
import { imageCapability } from '@momonga/protocol';
import type { Capabilities } from '@momonga/protocol';
import { createScriptedAdapter } from '@momonga/testkit';
import { getJson, startGateway } from './gateway-helpers.ts';

const IMAGE_MODEL = { pixelsPerToken: 750, maxTokens: 1600 };

const strong: Capabilities = {
  contextWindow: 8192,
  maxOutputTokens: 1024,
  toolCalling: 'native',
  structuredOutput: 'json_schema',
  streaming: true,
  stopSequences: true,
  imageInput: true,
  imageTokens: IMAGE_MODEL,
  parallelToolCalls: true,
  schemaDialect: 'json-schema-2020-12',
  tokenCounting: 'exact',
  usageReported: true,
  maxConcurrency: 4,
  source: 'declared',
};

const middle: Capabilities = {
  contextWindow: 4096,
  maxOutputTokens: 2048,
  toolCalling: 'constrained',
  structuredOutput: 'json_schema',
  streaming: true,
  stopSequences: false,
  imageInput: true,
  imageTokens: IMAGE_MODEL,
  parallelToolCalls: true,
  schemaDialect: 'guided-generation',
  tokenCounting: 'calibrated',
  usageReported: true,
  maxConcurrency: 2,
  source: 'probed',
};

const weak: Capabilities = {
  contextWindow: 16384,
  maxOutputTokens: 512,
  toolCalling: 'native',
  structuredOutput: 'none',
  streaming: false,
  stopSequences: true,
  imageInput: false,
  parallelToolCalls: false,
  schemaDialect: 'json-schema-2020-12',
  tokenCounting: 'exact',
  usageReported: false,
  maxConcurrency: 8,
  source: 'unprobed',
};

const plain: Capabilities = { ...strong, toolCalling: 'none', tokenCounting: 'estimated', source: 'config' };

const target = (capabilities: Capabilities) => ({ model: `model-${capabilities.source}`, maxConcurrency: capabilities.maxConcurrency });

const startWith = () =>
  startGateway({
    adapters: {
      strong: createScriptedAdapter({ calls: [], capabilities: strong }),
      middle: createScriptedAdapter({ calls: [], capabilities: middle }),
      weak: createScriptedAdapter({ calls: [], capabilities: weak }),
      plain: createScriptedAdapter({ calls: [], capabilities: plain }),
    },
    config: {
      aliases: { merged: ['strong', 'middle', 'weak'], single: ['middle'], none: ['strong', 'plain'], reversed: ['weak', 'strong'] },
      targets: { strong: target(strong), middle: target(middle), weak: target(weak), plain: target(plain) },
    },
  });

const capabilitiesOf = async (alias: string): Promise<Capabilities> => {
  const { client } = await startWith();
  const response = await getJson(client, '/v1/momonga/models');
  expect(response.status).toBe(200);
  return response.body.data.find((entry: { id: string }) => entry.id === alias).capabilities;
};

describe('alias capabilities on /v1/momonga/models', () => {
  it('reports a conservative merge over every target of the alias', async () => {
    expect(await capabilitiesOf('merged')).toEqual({
      contextWindow: 4096,
      maxOutputTokens: 512,
      toolCalling: 'constrained',
      structuredOutput: 'none',
      streaming: false,
      stopSequences: false,
      imageInput: false,
      parallelToolCalls: false,
      schemaDialect: 'guided-generation',
      tokenCounting: 'calibrated',
      usageReported: false,
      maxConcurrency: 2,
      source: 'declared',
    });
  });

  it('ranks toolCalling none below constrained and tokenCounting estimated lowest', async () => {
    const merged = await capabilitiesOf('none');
    expect(merged.toolCalling).toBe('none');
    expect(merged.tokenCounting).toBe('estimated');
    expect(merged.source).toBe('declared');
  });

  it('takes source from the first target of the alias', async () => {
    const merged = await capabilitiesOf('reversed');
    expect(merged.source).toBe('unprobed');
    expect(merged.contextWindow).toBe(8192);
    expect(merged.structuredOutput).toBe('none');
  });

  it('reports a single-target alias unchanged', async () => {
    expect(await capabilitiesOf('single')).toEqual(middle);
  });
});

describe('alias image token model on /v1/momonga/models', () => {
  const sees = (imageTokens: Capabilities['imageTokens']): Capabilities => {
    const { imageInput: _imageInput, imageTokens: _imageTokens, ...core } = strong;
    return { ...core, ...imageCapability(imageTokens !== undefined, imageTokens) };
  };

  const mergedOf = async (first: Capabilities, second: Capabilities): Promise<Capabilities> => {
    const { client } = await startGateway({
      adapters: { first: createScriptedAdapter({ calls: [], capabilities: first }), second: createScriptedAdapter({ calls: [], capabilities: second }) },
      config: {
        aliases: { both: ['first', 'second'] },
        targets: { first: { model: 'model-first' }, second: { model: 'model-second' } },
      },
    });
    const response = await getJson(client, '/v1/momonga/models');
    return response.body.data.find((entry: { id: string }) => entry.id === 'both').capabilities;
  };

  it('reports the smallest pixelsPerToken and the largest maxTokens when every target declares a model', async () => {
    const merged = await mergedOf(sees({ pixelsPerToken: 750, maxTokens: 1600 }), sees({ pixelsPerToken: 500, maxTokens: 1000 }));
    expect(merged.imageTokens).toEqual({ pixelsPerToken: 500, maxTokens: 1600 });
  });

  it('omits the model when a target of the alias declares none', async () => {
    const merged = await mergedOf(sees({ pixelsPerToken: 750, maxTokens: 1600 }), sees(undefined));
    expect(merged.imageTokens).toBeUndefined();
  });
});
