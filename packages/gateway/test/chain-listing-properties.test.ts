import { describe, expect, it, vi } from 'vitest';
import { isNotListedCapabilities } from '@momonga/protocol';
import type { Capabilities, ChainRoomFacts, ProviderAdapter } from '@momonga/protocol';
import { PROPERTY_TIMEOUT_MS, createFakeClock, createFakeTimers, createScriptedAdapter } from '@momonga/testkit';
import { seeded } from '../../context/test/helpers.ts';
import { invalidRequest } from '../src/core/errors.ts';
import { createReasoningOriginCodec } from '../src/core/reasoning-origin.ts';
import { createRedactor } from '../src/core/redaction.ts';
import { createRouter, mergeCapabilities } from '../src/core/router.ts';
import { targetProbingError } from '../src/probe/auto-probe.ts';
import { listModel } from '../src/server/capability-listing.ts';
import { capabilityFailingAdapter } from './capability-failing-adapter.ts';
import { HMAC_KEY, START_MS, buildConfig } from './gateway-helpers.ts';

vi.setConfig({ testTimeout: PROPERTY_TIMEOUT_MS });

const SEEDS = 200;
const STATES = ['listed', 'probing', 'unavailable'] as const;
type State = (typeof STATES)[number];

const BASE: Capabilities = {
  contextWindow: 8192,
  maxOutputTokens: 1024,
  toolCalling: 'native',
  structuredOutput: 'json_schema',
  streaming: true,
  stopSequences: true,
  imageInput: false,
  schemaDialect: 'json-schema-2020-12',
  tokenCounting: 'exact',
  usageReported: true,
  maxConcurrency: 4,
  source: 'declared',
};

const ROOMY: ChainRoomFacts = { outputBounded: true, contextWindow: 8192, maxOutputTokens: 1024 };
const CRAMPED: ChainRoomFacts = { outputBounded: false, contextWindow: 1000, maxOutputTokens: 990 };

const capabilitiesOf = (index: number): Capabilities => ({ ...BASE, maxConcurrency: 1 + index });

const adapterOf = (state: State, index: number, facts: ChainRoomFacts): ProviderAdapter => {
  const inner: ProviderAdapter = { ...createScriptedAdapter({ calls: [], capabilities: capabilitiesOf(index) }), roomFacts: async () => facts };
  if (state === 'listed') return inner;
  const fails = state === 'probing' ? () => targetProbingError({ state: 'probing', message: 'measuring', retryAfterSeconds: 60, measuring: { fields: ['toolCalling'], step: null, elapsedSeconds: 0, declaration: 'declare toolCalling for the model in its settings' } }) : () => invalidRequest('capabilities_unknown', 'no numbers', 'model', 412);
  return { ...capabilityFailingAdapter({ inner, fails }), roomFacts: async () => { throw fails(); } };
};

type Generated = { canons: string[]; fallback: string[]; states: State[]; refuse: boolean };

const generate = (seed: number): Generated => {
  const random = seeded(seed);
  const canons = Array.from({ length: random.int(1, 4) }, (_unused, index) => `s${index}/m${index}`);
  const fallback = Array.from({ length: random.int(0, 3) }, () => canons[random.int(0, canons.length - 1)] as string);
  const states = canons.map(() => STATES[random.int(0, STATES.length - 1)] as State);
  return { canons, fallback, states, refuse: random.int(0, 1) === 1 };
};

const listingOf = async ({ canons, fallback, states, refuse }: Generated) => {
  const facts = refuse ? CRAMPED : ROOMY;
  const clock = createFakeClock(START_MS);
  const chains = Object.fromEntries(canons.map((canon) => [canon, [...new Set([canon, ...fallback])]]));
  const router = createRouter({
    config: buildConfig({ targets: Object.fromEntries(canons.map((canon) => [canon, {}])), chains }),
    adapters: Object.fromEntries(canons.map((canon, index) => [canon, adapterOf(states[index] as State, index, facts)])),
    clock,
    timers: createFakeTimers(clock),
    redactor: createRedactor({ credentials: [] }),
    reasoningOrigin: createReasoningOriginCodec(HMAC_KEY),
  });
  const signal = new AbortController().signal;
  return { chains, entries: await Promise.all(canons.map((canon) => listModel(router, canon, signal))) };
};

describe('I-N18: the entry of a model is not listed exactly when the model itself is guarded or the room of its fold is refused', () => {
  it(
    'holds for generated chains, whatever the state of the fallback members',
    async () => {
      for (let seed = 1; seed <= SEEDS; seed += 1) {
        const generated = generate(seed);
        const { chains, entries } = await listingOf(generated);
        for (const [position, entry] of entries.entries()) {
          const ownState = generated.states[position] as State;
          const guarded = ownState !== 'listed';
          expect(isNotListedCapabilities(entry.capabilities), `seed ${seed} ${entry.id}`).toBe(guarded || generated.refuse);
          if (guarded || generated.refuse) continue;
          const members = (chains[entry.id] as string[]).map((canon) => generated.canons.indexOf(canon));
          const [first, ...rest] = members.filter((index) => generated.states[index] === 'listed').map(capabilitiesOf);
          if (first === undefined) throw new Error(`seed ${seed}: the entry ${entry.id} is listed with no listed member`);
          expect(entry.capabilities, `seed ${seed} ${entry.id}`).toEqual(mergeCapabilities([first, ...rest]));
        }
        for (let member = 0; member < generated.canons.length; member += 1) {
          const flipped: Generated = { ...generated, states: generated.states.map((state, index) => (index === member ? (state === 'listed' ? 'unavailable' : 'listed') : state)) };
          const after = (await listingOf(flipped)).entries;
          for (const [position, entry] of entries.entries()) {
            if (position === member) continue;
            expect(isNotListedCapabilities((after[position] as (typeof after)[number]).capabilities), `seed ${seed} ${entry.id} after flipping ${generated.canons[member]}`).toBe(isNotListedCapabilities(entry.capabilities));
          }
        }
      }
    },
  );
});
