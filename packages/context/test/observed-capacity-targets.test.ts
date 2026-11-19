import { describe, expect, it } from 'vitest';
import { buildContext, budgetFor, capacityFor } from '@momonga/context';
import type { BuildContextInput, BuildContextPorts, HistoryItem, TokenMeter } from '@momonga/context';
import { COMPACT_AT, floorRatio } from '@momonga/protocol';
import type { Capabilities } from '@momonga/protocol';
import { HOME, MODEL, PROJECT, SYSTEM_PROMPT, TASK, assistant, call, capabilitiesFor, fakeBlobs, fakeReader, output, sourcesWith, user, withTurnsBeforeCurrent } from './helpers.ts';
import { weightMeter, weightOf, weightOfAll } from './weight-meter.ts';
import type { UnderRule, WeightMeter } from './weight-meter.ts';
import { TEST_FENCE } from '@momonga/testkit';

type PortsWithFallbacks = BuildContextPorts & { fallbackMeters: readonly TokenMeter[] };

const portsWith = (model: WeightMeter, fallbacks: readonly WeightMeter[]): BuildContextPorts => {
  const ports: PortsWithFallbacks = { meter: model, fallbackMeters: fallbacks, blobs: fakeBlobs(), instructions: fakeReader() };
  return ports;
};

const observedInput = (capabilities: Capabilities, history: HistoryItem[]): BuildContextInput => {
  const input: BuildContextInput & { observedCapacity: true } = {
    reasoningRoom: 0,
    capabilities,
    fence: TEST_FENCE,
    model: MODEL,
    sources: sourcesWith({ history }),
    evicted: new Set<string>(),
    recordedReferences: new Set<string>(),
    touchedPaths: [],
    trusted: true,
    projectRoot: PROJECT,
    home: HOME,
    observedCapacity: true,
  };
  return input;
};

const floorTokens = weightOf({ type: 'message', role: 'system', content: SYSTEM_PROMPT }) + weightOf(TASK);

const historyTotalling = (target: number): HistoryItem[] => {
  const withPad = (pad: number): HistoryItem[] =>
    withTurnsBeforeCurrent([user(1, 'old question'), call(2, 'c1'), output(3, 'c1', 'o'.repeat(300)), assistant(4, 'old answer'), user(5, 'p'.repeat(pad))]);
  return withPad(target - floorTokens - weightOfAll(withPad(0).map((entry) => entry.item)));
};

const estimated = capabilitiesFor(8192, { tokenCounting: 'estimated', maxOutputTokens: 1024 });
const nothingUnder: UnderRule = () => 0;
const wholeUnder: UnderRule = (tokens) => tokens;
const highMarkOf = (capacity: number): number => floorTokens + floorRatio(COMPACT_AT, capacity - floorTokens);

describe('C is the minimum of C_t over the model targets (4.7, M5; B9, B10)', () => {
  const smallerCapacity = capacityFor(estimated, wholeUnder);
  const aliasCapacity = capacityFor(estimated, nothingUnder);

  it('has a fallback target whose C_t is below the model meter capacity', () => {
    expect(aliasCapacity).toBe(budgetFor(estimated, 0, 0).I);
    expect(highMarkOf(smallerCapacity) + 1).toBeLessThan(highMarkOf(aliasCapacity));
  });

  it('evicts above the high mark of the fallback target C_t while the model meter alone would keep everything', async () => {
    const history = historyTotalling(highMarkOf(smallerCapacity) + 1);

    const built = await buildContext(observedInput(estimated, history), portsWith(weightMeter(nothingUnder), [weightMeter(wholeUnder)]));

    expect(built.evictions.map((eviction) => eviction.callId)).toEqual(['c1']);
  });

  it('counts the build input through every fallback meter', async () => {
    const fallback = weightMeter(nothingUnder);

    await buildContext(observedInput(estimated, [user(1, 'question')]), portsWith(weightMeter(nothingUnder), [fallback]));

    expect(fallback.requests.length).toBeGreaterThan(0);
  });
});
