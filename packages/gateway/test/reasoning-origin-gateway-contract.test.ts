import { describe, expect, expectTypeOf, it } from 'vitest';
import { canonicalJson } from '@momonga/foundation';
import type { StreamEvent } from '@momonga/protocol';
import { createScriptedAdapter, textResponseEvents } from '@momonga/testkit';
import { guardAdapter } from '../src/core/guarded-adapter.ts';
import type { ReasoningOriginCodec } from '../src/core/reasoning-origin.ts';
import { postJson, readJson, startGateway, userInput } from './gateway-helpers.ts';
import { ask, occurrences, reasoningOf, startWorld, thoughtOf } from './reasoning-origin-support.ts';

describe('guardAdapter always carries the reasoning origin codec (item 5)', () => {
  it('takes the codec as a required third parameter', () => {
    expectTypeOf(guardAdapter).parameter(2).toEqualTypeOf<ReasoningOriginCodec>();
  });
});

describe('the origin travels outside the request data (item 5)', () => {
  it('lets an adapter digest the request it receives with canonicalJson', async () => {
    const base = createScriptedAdapter({ calls: [] });
    const events = textResponseEvents({ model: 'scripted-primary', chunks: ['ok'] });
    const digests: string[] = [];
    const primary = {
      ...base,
      create: async function* (request: Parameters<typeof base.create>[0]): AsyncGenerator<StreamEvent> {
        digests.push(canonicalJson(request));
        yield* events;
      },
    };
    const { client } = await startGateway({ adapters: { 'scripted/scripted-primary': primary } });
    const response = await readJson(await postJson(client, '/v1/responses', { model: 'scripted/scripted-primary', input: userInput('hi') }));
    expect(response.status).toBe(200);
    expect(digests).toHaveLength(1);
  });
});

describe('compaction through the gateway sends only own reasoning (item 5)', () => {
  const MODEL = 'relay-model-x';
  it('open-responses: the summary request holds the own reasoning text and not the foreign one', async () => {
    const own = thoughtOf('open-responses', MODEL);
    const foreign = thoughtOf('ollama', 'qwen-model-x');
    const world = await startWorld([
      { name: 'open-responses', kind: 'open-responses', model: MODEL, script: [{ reasoning: own }, { text: 'the summary' }] },
      { name: 'ollama', kind: 'ollama', model: 'qwen-model-x', script: [{ reasoning: foreign }] },
    ]);
    const ownOutput = await world.turn('open-responses', ask('one'));
    const foreignOutput = await world.turn('ollama', [...ask('one'), ...ownOutput, ...ask('two')]);
    expect(reasoningOf(foreignOutput).encrypted_content).not.toBe(reasoningOf(ownOutput).encrypted_content);
    const history = [...ask('one'), ...ownOutput, ...ask('two'), ...foreignOutput];

    const response = await readJson(await postJson(world.client, '/v1/responses/compact', { model: world.modelOf('open-responses'), input: history }));

    expect(response.status).toBe(200);
    const wire = world.upstreams['open-responses']!.wire();
    expect([occurrences(wire, own.text), occurrences(wire, foreign.text)]).toEqual([1, 0]);
  });
});
