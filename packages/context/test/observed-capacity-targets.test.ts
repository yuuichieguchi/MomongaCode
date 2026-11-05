import { describe, expect, it } from 'vitest';
import { buildContext, budgetFor, capacityFor } from '@momonga/context';
import type { BuildContextInput, BuildContextPorts, HistoryItem, TokenMeter } from '@momonga/context';
import { COMPACT_AT, floorRatio } from '@momonga/protocol';
import type { Capabilities } from '@momonga/protocol';
import { HOME, MODEL, PROJECT, SYSTEM_PROMPT, TASK, assistant, call, capabilitiesFor, fakeBlobs, fakeReader, output, sourcesWith, user } from './helpers.ts';
import { weightMeter, weightOf, weightOfAll } from './weight-meter.ts';
import type { UnderRule, WeightMeter } from './weight-meter.ts';

type PortsWithFallbacks = BuildContextPorts & { fallbackMeters: readonly TokenMeter[] };

const portsWith = (alias: WeightMeter, fallbacks: readonly WeightMeter[]): BuildContextPorts => {
  const ports: PortsWithFallbacks = { meter: alias, fallbackMeters: fallbacks, blobs: fakeBlobs(), instructions: fakeReader() };
  return ports;
};

const observedInput = (capabilities: Capabilities, history: HistoryItem[]): BuildContextInput => {
  const input: BuildContextInput & { observedCapacity: true } = {
    capabilities,
    model: MODEL,
    sources: sourcesWith({ history }),
    evicted: new Set<string>(),
    recordedReferences: new Set<string>(),
    touchedPaths: [],
    trusted: true,
    projectRoot: PROJECT,
    home: HOME,
    keepRecentTurns: 1,
    observedCapacity: true,
  };
  return input;
};

const floorTokens = weightOf({ type: 'message', role: 'system', content: SYSTEM_PROMPT }) + weightOf(TASK);

const historyTotalling = (target: number): HistoryItem[] => {
  const old = [user(1, 'old question'), call(2, 'c1'), output(3, 'c1', 'o'.repeat(300)), assistant(4, 'old answer')];
  const empty = user(5, '');
  const pad = target - floorTokens - weightOfAll(old.map((entry) => entry.item)) - weightOf(empty.item);
  return [...old, user(5, 'p'.repeat(pad))];
};

const estimated = capabilitiesFor(8192, { tokenCounting: 'estimated', maxOutputTokens: 1024 });
const nothingUnder: UnderRule = () => 0;
const wholeUnder: UnderRule = (tokens) => tokens;
const highMarkOf = (capacity: number): number => floorTokens + floorRatio(COMPACT_AT, capacity - floorTokens);

describe('C is the minimum of C_t over the alias targets (4.7, M5; B9, B10)', () => {
  const smallerCapacity = capacityFor(estimated, wholeUnder);
  const aliasCapacity = capacityFor(estimated, nothingUnder);

  it('has a fallback target whose C_t is below the alias meter capacity', () => {
    expect(aliasCapacity).toBe(budgetFor(estimated, 0).I);
    expect(highMarkOf(smallerCapacity) + 1).toBeLessThan(highMarkOf(aliasCapacity));
  });

  it('evicts above the high mark of the fallback target C_t while the alias meter alone would keep everything', async () => {
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
