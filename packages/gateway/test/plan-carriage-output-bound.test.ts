import { describe, expect, it } from 'vitest';
import type { CapabilityOverride } from '@momonga/protocol';
import { createScriptedAdapter, textResponseEvents, usageOf } from '@momonga/testkit';
import type { ScriptedAdapter } from '@momonga/testkit';
import { REFUSAL_STAGES } from '../src/core/candidate-refusal.ts';
import { getJson, postJson, readJson, startGateway, userInput } from './gateway-helpers.ts';

const answering = (model: string, capabilities: CapabilityOverride): ScriptedAdapter =>
  createScriptedAdapter({
    capabilities,
    calls: [
      { events: textResponseEvents({ model, chunks: ['answer'], usage: usageOf(5, 1) }) },
      { events: textResponseEvents({ model, chunks: ['answer'], usage: usageOf(5, 1) }) },
    ],
  });

const UNBOUNDED: CapabilityOverride = { outputBoundField: 'none', contextWindow: 8192, maxOutputTokens: 4096 };
const BOUNDED: CapabilityOverride = { outputBoundField: 'max_output_tokens', contextWindow: 16384, maxOutputTokens: 1024 };

const startAlias = async (members: Record<string, CapabilityOverride>) => {
  const adapters = Object.fromEntries(Object.entries(members).map(([name, capabilities]) => [name, answering(`model-${name}`, capabilities)]));
  const harness = await startGateway({
    adapters,
    config: {
      aliases: { fast: Object.keys(members) },
      targets: Object.fromEntries(Object.keys(members).map((name) => [name, { model: `model-${name}` }])),
    },
  });
  const post = async (body: Record<string, unknown>) => readJson(await postJson(harness.client, '/v1/responses', { model: 'fast', input: userInput('hi'), ...body }));
  return { harness, adapters: adapters as Record<string, ScriptedAdapter>, post };
};

describe('narrowing refuses a target that carries no output bound for a request that carries one (P2 item 2, I-K1)', () => {
  it('names outputBound and inputKinds as refusal stages of their own', () => {
    expect(REFUSAL_STAGES).toEqual({ tools: 0, images: 1, inputKinds: 2, sampling: 3, outputBound: 4, toolChoice: 5, summaryCap: 6, unknownFields: 7, inputSize: 8 });
  });

  it('passes over the unbounded member and serves max_output_tokens from the bounded one', async () => {
    const alias = await startAlias({ unbounded: UNBOUNDED, bounded: BOUNDED });
    const response = await alias.post({ max_output_tokens: 64 });
    expect(response.status).toBe(200);
    expect(alias.adapters['unbounded']?.calls).toHaveLength(0);
    expect(alias.adapters['bounded']?.calls).toHaveLength(1);
    expect(alias.adapters['bounded']?.calls[0]?.request.max_output_tokens).toBe(64);
  });

  it('answers capability_unsupported naming max_output_tokens when every member is unbounded, and still serves a request without a bound', async () => {
    const alias = await startAlias({ first: UNBOUNDED, second: UNBOUNDED });
    const refused = await alias.post({ max_output_tokens: 64 });
    expect(refused.status).toBe(400);
    expect(refused.body.error.type).toBe('invalid_request');
    expect(refused.body.error.code).toBe('capability_unsupported');
    expect(refused.body.error.param).toBe('max_output_tokens');
    expect(alias.adapters['first']?.calls).toHaveLength(0);
    expect(alias.adapters['second']?.calls).toHaveLength(0);

    const served = await alias.post({});
    expect(served.status).toBe(200);
    expect(alias.adapters['first']?.calls).toHaveLength(1);
  });
});

describe('the alias merge takes the weakest output bound and the largest unbounded output (P2 items 3 and 6)', () => {
  const capabilitiesOf = async (members: Record<string, CapabilityOverride>) => {
    const alias = await startAlias(members);
    const response = await getJson(alias.harness.client, '/v1/momonga/models');
    expect(response.status).toBe(200);
    return response.body.data.find((entry: { id: string }) => entry.id === 'fast').capabilities;
  };

  it('reports outputBoundField none and unboundedOutputTokens as the largest maxOutputTokens of any member when one member is unbounded', async () => {
    const merged = await capabilitiesOf({ bounded: BOUNDED, unbounded: UNBOUNDED });
    expect(merged.outputBoundField).toBe('none');
    expect(merged.unboundedOutputTokens).toBe(4096);
    expect(merged.maxOutputTokens).toBe(1024);
    expect(merged.contextWindow).toBe(8192);

    const allBounded = await capabilitiesOf({ bounded: BOUNDED, other: { ...BOUNDED, maxOutputTokens: 2048 } });
    expect(allBounded.outputBoundField).not.toBe('none');
    expect(allBounded).not.toHaveProperty('unboundedOutputTokens');
  });
});
