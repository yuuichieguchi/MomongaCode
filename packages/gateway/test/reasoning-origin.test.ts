import { describe, expect, it } from 'vitest';
import {
  ADAPTER_KINDS,
  OTHER_GATEWAY_KEY,
  ask,
  occurrences,
  reasoningOf,
  startWorld,
  strictHistory,
  strictReasoning,
  tampered,
  thoughtOf,
  verifiedEnvelope,
} from './reasoning-origin-support.ts';
import type { AdapterKind, TargetPlan } from './reasoning-origin-support.ts';

const MODEL_OF: Record<AdapterKind, string> = {
  'chat-completions': 'cc-model-x',
  anthropic: 'claude-model-x',
  ollama: 'qwen-model-x',
  'open-responses': 'relay-model-x',
};

const CARRIES_UPSTREAM_OPAQUE: readonly AdapterKind[] = ['anthropic', 'open-responses'];

const ownPlan = (kind: AdapterKind, extraReplies = 1): TargetPlan => ({
  name: kind,
  kind,
  model: MODEL_OF[kind],
  script: [{ reasoning: thoughtOf(kind, MODEL_OF[kind]) }, ...Array.from({ length: extraReplies }, () => ({ text: 'ok' }))],
});

const producedBy = async (kind: AdapterKind) => {
  const world = await startWorld([ownPlan(kind)]);
  const output = await world.turn(kind, ask('think'));
  return { world, output, thought: thoughtOf(kind, MODEL_OF[kind]) };
};

describe('each target is sent only the reasoning it produced, judged by the signed marker in encrypted_content (item 5)', () => {
  for (const own of ADAPTER_KINDS) {
    it(`${own} sends its own item and none of the other three adapters' items`, async () => {
      const world = await startWorld(ADAPTER_KINDS.map((kind) => ownPlan(kind)));
      let history: unknown[] = [];
      for (const kind of ADAPTER_KINDS) {
        history = [...history, ...ask(`turn on ${kind}`)];
        history = [...history, ...(await world.turn(kind, history))];
      }
      await world.turn(own, [...history, ...ask('again')]);

      const wire = world.upstreams[own]!.wire();
      expect(ADAPTER_KINDS.map((kind) => [kind, occurrences(wire, thoughtOf(kind, MODEL_OF[kind]).text)])).toEqual(
        ADAPTER_KINDS.map((kind) => [kind, kind === own ? 1 : 0]),
      );
      expect(CARRIES_UPSTREAM_OPAQUE.map((kind) => [kind, occurrences(wire, thoughtOf(kind, MODEL_OF[kind]).opaque)])).toEqual(
        CARRIES_UPSTREAM_OPAQUE.map((kind) => [kind, kind === own ? 1 : 0]),
      );
    });
  }
});

describe('two targets of the same adapter with different model ids are told apart (item 5)', () => {
  for (const kind of ADAPTER_KINDS) {
    it(`${kind} on model y leaves out the item model x produced`, async () => {
      const x = thoughtOf(kind, 'model-x');
      const y = thoughtOf(kind, 'model-y');
      const world = await startWorld([
        { name: 'x', kind, model: 'model-x', script: [{ reasoning: x }] },
        { name: 'y', kind, model: 'model-y', script: [{ reasoning: y }, { text: 'ok' }] },
      ]);
      const first = [...ask('one'), ...(await world.turn('x', ask('one')))];
      const second = [...first, ...ask('two')];
      const history = [...second, ...(await world.turn('y', second)), ...ask('again')];
      await world.turn('y', history);

      const wire = world.upstreams['y']!.wire();
      expect([occurrences(wire, x.text), occurrences(wire, y.text), occurrences(wire, x.opaque)]).toEqual([0, 1, 0]);
    });
  }
});

describe('the gateway signs the origin into the encrypted_content of a produced reasoning item (item 5)', () => {
  for (const kind of ADAPTER_KINDS) {
    it(`${kind}: encrypted_content verifies to the adapter and the target model, and the upstream gets its own opaque data back unchanged`, async () => {
      const { world, output, thought } = await producedBy(kind);
      const item = reasoningOf(output);
      const envelope = verifiedEnvelope(item.encrypted_content);
      expect(envelope === undefined ? undefined : { adapter: envelope['adapter'], model: envelope['model'] }).toEqual({ adapter: kind, model: MODEL_OF[kind] });
      expect(String(item.encrypted_content).includes(thought.opaque)).toBe(false);

      await world.turn(kind, [...ask('think'), ...output, ...ask('again')]);
      const wire = world.upstreams[kind]!.wire();
      expect(occurrences(wire, thought.text)).toBe(1);
      if (kind === 'anthropic') {
        const blocks = JSON.parse(wire).flatMap((message: any) => (Array.isArray(message.content) ? message.content : [])).filter((block: any) => block.type === 'thinking');
        expect(blocks).toEqual([{ type: 'thinking', thinking: thought.text, signature: thought.opaque }]);
      }
      if (kind === 'open-responses') {
        expect(JSON.parse(wire).filter((entry: any) => entry.type === 'reasoning').map((entry: any) => entry.encrypted_content)).toEqual([thought.opaque]);
      }
    });
  }
});

describe('a reasoning item whose origin cannot be established is foreign and left off the wire (item 5)', () => {
  for (const kind of ADAPTER_KINDS) {
    it(`${kind}: an item with no encrypted_content, as a strict client might send it, is dropped`, async () => {
      const { world, output, thought } = await producedBy(kind);
      const bare = strictHistory(output).map((item) => {
        if (item.type !== 'reasoning') return item;
        const { encrypted_content: _dropped, ...rest } = item;
        return rest;
      });
      await world.turn(kind, [...ask('think'), ...bare, ...ask('again')]);
      expect(occurrences(world.upstreams[kind]!.wire(), thought.text)).toBe(0);
    });

    it(`${kind}: an item whose signed encrypted_content was tampered with is dropped`, async () => {
      const { world, output, thought } = await producedBy(kind);
      const item = reasoningOf(output);
      expect(typeof item.encrypted_content).toBe('string');
      const forged = output.map((entry) => (entry.type === 'reasoning' ? { ...entry, encrypted_content: tampered(entry.encrypted_content) } : entry));
      await world.turn(kind, [...ask('think'), ...forged, ...ask('again')]);
      const wire = world.upstreams[kind]!.wire();
      expect([occurrences(wire, thought.text), occurrences(wire, thought.opaque)]).toEqual([0, 0]);
    });

    it(`${kind}: an item signed with another gateway's key is dropped, though adapter and model match`, async () => {
      const elsewhere = await startWorld([{ ...ownPlan(kind), script: [{ reasoning: thoughtOf(kind, MODEL_OF[kind]) }] }], OTHER_GATEWAY_KEY);
      const foreignOutput = await elsewhere.turn(kind, ask('think'));
      const here = await startWorld([{ ...ownPlan(kind), script: [{ text: 'ok' }] }]);
      await here.turn(kind, [...ask('think'), ...foreignOutput, ...ask('again')]);
      const wire = here.upstreams[kind]!.wire();
      const thought = thoughtOf(kind, MODEL_OF[kind]);
      expect([occurrences(wire, thought.text), occurrences(wire, thought.opaque)]).toEqual([0, 0]);
    });
  }
});

describe('a strict client keeping only the ReasoningItemParam fields round-trips its own reasoning (item 5)', () => {
  for (const kind of ADAPTER_KINDS) {
    it(`${kind} resends the item from id, type, summary, content and encrypted_content alone`, async () => {
      const { world, output, thought } = await producedBy(kind);
      const strict = strictReasoning(reasoningOf(output));
      expect(Object.keys(strict).every((field) => ['id', 'type', 'summary', 'content', 'encrypted_content'].includes(field))).toBe(true);
      await world.turn(kind, [...ask('think'), ...strictHistory(output), ...ask('again')]);
      const wire = world.upstreams[kind]!.wire();
      expect(occurrences(wire, thought.text)).toBe(1);
      if (CARRIES_UPSTREAM_OPAQUE.includes(kind)) expect(occurrences(wire, thought.opaque)).toBe(1);
    });
  }
});
