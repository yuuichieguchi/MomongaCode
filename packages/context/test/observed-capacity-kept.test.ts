import { describe, expect, it } from 'vitest';
import { createTokenMeter } from '@momonga/context';
import type { TokenMeterOptions } from '@momonga/context';
import type { InputItem } from '@momonga/protocol';
import { MODEL, capabilitiesFor, fakeCounter, tokensOfItems } from './helpers.ts';

const message = (id: string, text: string): InputItem => ({ type: 'message', id, role: 'user', content: text });

const prefix: InputItem[] = [message('p1', 'alpha '.repeat(30)), message('p2', 'beta '.repeat(30))];
const suffix: InputItem[] = [message('s1', 'gamma '.repeat(10)), message('s2', 'delta')];

const OVER_COUNT = 20;

type ObservedMeterOptions = TokenMeterOptions & { observedCapacity?: boolean };

const meterWith = (observedCapacity: boolean) => {
  const options: ObservedMeterOptions = { counter: fakeCounter(), model: MODEL, capabilities: capabilitiesFor(200_000), observedCapacity };
  return createTokenMeter(options);
};

describe('kept = reported with context.observedCapacity (4.7, M5; B8 (iii))', () => {
  it('journals the report itself as kept when the count was higher', async () => {
    const meter = meterWith(true);
    const first = await meter.count({ input: prefix, tools: [] });
    const reported = first.inputTokens - OVER_COUNT;

    const observation = meter.observe({ inputDigest: first.inputDigest, inputTokens: reported });

    expect(observation.kept).toBe(reported);
  });

  it('carries the report, not the higher count, as the known part of the next split', async () => {
    const meter = meterWith(true);
    const first = await meter.count({ input: prefix, tools: [] });
    const reported = first.inputTokens - OVER_COUNT;
    meter.observe({ inputDigest: first.inputDigest, inputTokens: reported });

    const appended = await meter.count({ input: [...prefix, ...suffix], tools: [] });

    expect(appended.known).toBe(reported);
    expect(appended.inputTokens).toBe(reported + tokensOfItems(suffix));
    expect(appended.overTolerance).toBe(0);
  });

  it('carries the report as known after restoring an observation journaled with the setting off', async () => {
    const off = meterWith(false);
    const first = await off.count({ input: prefix, tools: [] });
    const reported = first.inputTokens - OVER_COUNT;
    const observation = off.observe({ inputDigest: first.inputDigest, inputTokens: reported });
    expect(observation.kept).toBe(first.inputTokens);

    const on = meterWith(true);
    on.restore({ latest: { input: prefix, tools: [], observation }, misses: [] });
    const appended = await on.count({ input: [...prefix, ...suffix], tools: [] });

    expect(appended.known).toBe(reported);
    expect(appended.overTolerance).toBe(0);
  });

  it('keeps max(count, reported) without the setting', async () => {
    const meter = meterWith(false);
    const first = await meter.count({ input: prefix, tools: [] });

    const observation = meter.observe({ inputDigest: first.inputDigest, inputTokens: first.inputTokens - OVER_COUNT });

    expect(observation.kept).toBe(first.inputTokens);
  });
});
