import { describe, expect, it } from 'vitest';
import { budgetFor, buildContext, createTokenMeter, measurePinned } from '@momonga/context';
import type { BuildContextPorts, TokenMeter } from '@momonga/context';
import type { Capabilities, InputItem } from '@momonga/protocol';
import {
  MODEL,
  buildThroughLevels,
  call,
  capabilitiesFor,
  fakeBlobs,
  fakeCounter,
  fakeReader,
  inputFor,
  output,
  overflowOf,
  ratioCounter,
  sourcesWith,
} from './helpers.ts';
import type { FakeCounter } from './helpers.ts';
import type { HistoryItem } from '@momonga/context';

const W8192 = capabilitiesFor(8192, { maxOutputTokens: 1024, tokenCounting: 'estimated' });

const argsSteps = (chars: readonly number[]): HistoryItem[] =>
  chars.flatMap((size, index) => [
    { seq: 2 * index + 1, item: { type: 'function_call', id: `h${2 * index + 1}`, call_id: `c${index}`, name: 'Read', arguments: `{"p":"${'x'.repeat(size)}"}` } },
    output(2 * index + 2, `c${index}`, 'ok'),
  ]);

const portsWith = (meter: TokenMeter): BuildContextPorts => ({ meter, blobs: fakeBlobs(), instructions: fakeReader() });

const meterWithObservedError = async (capabilities: Capabilities, counter: FakeCounter, relativeError: number): Promise<TokenMeter> => {
  const meter = createTokenMeter({ counter, model: MODEL, capabilities });
  const unrelated: InputItem = { type: 'message', role: 'user', content: 'u'.repeat(368) };
  const counted = await meter.count({ input: [unrelated], tools: [] });
  expect(counted.inputTokens).toBe(104);
  meter.observe({ inputDigest: counted.inputDigest, inputTokens: Math.round(104 * (1 + relativeError)) });
  expect(meter.relativeError()).toBe(relativeError);
  return meter;
};

describe('no ceiling drift between meters', () => {
  it('gives identical marks, caps and cut candidates for a fresh meter and one with a large observed error', async () => {
    const history = argsSteps([2799, 2799, 2799, 2799, 2799, 2798]);
    const input = inputFor(W8192, { sources: sourcesWith({ history }), level: 0 });
    const fresh = createTokenMeter({ counter: fakeCounter(0), model: MODEL, capabilities: W8192 });
    const skewed = await meterWithObservedError(W8192, fakeCounter(0), 0.5);

    const freshPinned = await measurePinned(input, portsWith(fresh));
    const skewedPinned = await measurePinned(input, portsWith(skewed));
    expect(skewedPinned).toEqual(freshPinned);
    expect(freshPinned).toEqual({ pinnedTokens: 32, ceiling: 5387, room: 5355, itemCap: 1751, summaryCap: 492 });

    const freshBuilt = await buildContext(input, portsWith(fresh));
    const skewedBuilt = await buildContext(input, portsWith(skewed));
    expect(freshBuilt.inputTokens).toBe(4478);
    expect(skewedBuilt.inputTokens).toBe(4478);
    expect(freshBuilt.compaction?.throughSeq).toBe(4);
    expect(skewedBuilt.compaction).toEqual(freshBuilt.compaction);
    expect(skewedBuilt.evictions).toEqual(freshBuilt.evictions);
    expect(skewedBuilt.budget.I).toBeLessThan(freshBuilt.budget.I);
  });

  it('lets only fits differ: the skewed meter overflows against the same ceiling', async () => {
    const history = argsSteps([3099, 3099, 3099, 3099, 3099, 3098]);
    const input = inputFor(W8192, { sources: sourcesWith({ history }), level: 0 });
    const fresh = createTokenMeter({ counter: fakeCounter(0), model: MODEL, capabilities: W8192 });
    const skewed = await meterWithObservedError(W8192, fakeCounter(0), 0.5);

    const built = await buildContext(input, portsWith(fresh));
    const error = await overflowOf(input, portsWith(skewed));

    expect(built.inputTokens).toBe(4928);
    expect(error.inputTokens).toBe(4928);
    expect(error.ceiling).toBe(5387);
    expect(error.inputBudget).toBe(7004 - 2464);
  });
});

describe('forced deficit against the ceiling and the live bound', () => {
  it.for([
    { label: 'region closes only the live deficit', chars: [2299, 2299, 4971, 4971, 4971, 4970], closes: false },
    { label: 'region closes the deficit against the ceiling', chars: [3499, 3499, 4371, 4371, 4371, 4370], closes: true },
  ])('measures against the ceiling when the live bound is looser: $label', async ({ chars, closes }) => {
    const meter = createTokenMeter({ counter: fakeCounter(0), model: MODEL, capabilities: W8192 });
    const error = await overflowOf(inputFor(W8192, { sources: sourcesWith({ history: argsSteps(chars) }), level: 0 }), portsWith(meter));

    expect(error.inputTokens).toBe(6400);
    expect(error.inputBudget).toBe(7004 - 640);
    expect(error.ceiling).toBe(5387);
    if (closes) {
      expect(error.compaction?.throughSeq).toBe(4);
    } else {
      expect(error.compaction).toBeUndefined();
      expect(error.compactionBlockedBy?.reason).toBe('deficit_not_closed');
    }
  });

  it.for([
    { label: 'region closes only the deficit against the ceiling', chars: [1699, 1699, 3871, 3871, 3871, 3870], closes: false },
    { label: 'region closes the live deficit', chars: [2499, 2499, 3471, 3471, 3471, 3470], closes: true },
  ])('measures against the live bound when the observed error exceeds the sizing ratio: $label', async ({ chars, closes }) => {
    const meter = await meterWithObservedError(W8192, fakeCounter(0), 0.5);
    const error = await overflowOf(inputFor(W8192, { sources: sourcesWith({ history: argsSteps(chars) }), level: 0 }), portsWith(meter));

    expect(error.inputTokens).toBe(5000);
    expect(error.inputBudget).toBe(7004 - 2500);
    if (closes) {
      expect(error.compaction?.throughSeq).toBe(4);
    } else {
      expect(error.compaction).toBeUndefined();
      expect(error.compactionBlockedBy?.reason).toBe('deficit_not_closed');
    }
  });
});

describe('accepted counts stay within I with the meter\'s own bound', () => {
  it('keeps every accepted build at or below budgetFor(capabilities, 0).I including the bound the meter returns', async () => {
    const capabilities = capabilitiesFor(4096, { maxOutputTokens: 1024, tokenCounting: 'estimated' });
    const I = budgetFor(capabilities, 0).I;
    expect(I).toBe(2990);
    const meter = createTokenMeter({ counter: ratioCounter(0.3), model: MODEL, capabilities });
    const ports = portsWith(meter);
    const history: HistoryItem[] = [...'abcdef'].flatMap((letter, index) => [call(2 * index + 1, `c${index}`), output(2 * index + 2, `c${index}`, letter.repeat(2400))]);

    const first = await buildThroughLevels(inputFor(capabilities, { sources: sourcesWith({ history }) }), ports);
    expect(first.level).toBe(1);
    expect(first.built.inputTokens).toBe(952);
    const firstCount = await meter.count({ input: first.built.input, tools: first.built.tools });
    expect(first.built.inputTokens + firstCount.errorBound).toBeLessThanOrEqual(I);

    meter.observe({ inputDigest: first.built.inputDigest, inputTokens: first.built.inputTokens });
    const handles = new Map(first.built.evictions.map((eviction) => [eviction.callId, eviction.handle]));
    const journaled = history.map((entry) =>
      entry.item.type === 'function_call_output' && handles.has(entry.item.call_id) ? { ...entry, handle: handles.get(entry.item.call_id) as string } : entry,
    );
    const appended = [...journaled, call(13, 'c6'), output(14, 'c6', 'g'.repeat(2400))];
    const second = await buildThroughLevels(
      inputFor(capabilities, { sources: sourcesWith({ history: appended }), evicted: new Set(handles.keys()) }),
      ports,
    );
    const secondCount = await meter.count({ input: second.built.input, tools: second.built.tools });
    expect(second.built.inputTokens + secondCount.errorBound).toBeLessThanOrEqual(I);
  });
});

describe('meter counts across in-turn builds', () => {
  it('counts an appended step with one suffix count after an eviction batch and an unchanged rebuild with none', async () => {
    const capabilities = capabilitiesFor(4000);
    const counter = fakeCounter(0);
    const meter = createTokenMeter({ counter, model: MODEL, capabilities });
    const ports = portsWith(meter);
    const history: HistoryItem[] = [...'abcdef'].flatMap((letter, index) => [call(2 * index + 1, `c${index}`), output(2 * index + 2, `c${index}`, letter.repeat(2400))]);
    const wholeCounts = () => counter.calls.filter((request) => (request as { momonga?: unknown }).momonga === undefined).length;

    const first = await buildContext(inputFor(capabilities, { sources: sourcesWith({ history }), level: 1 }), ports);
    expect(first.evictions.map((eviction) => eviction.callId)).toEqual(['c0', 'c1', 'c2', 'c3', 'c4']);
    meter.observe({ inputDigest: first.inputDigest, inputTokens: first.inputTokens });

    const handles = new Map(first.evictions.map((eviction) => [eviction.callId, eviction.handle]));
    const journaled = history.map((entry) =>
      entry.item.type === 'function_call_output' && handles.has(entry.item.call_id) ? { ...entry, handle: handles.get(entry.item.call_id) as string } : entry,
    );
    const appendedInput = inputFor(capabilities, {
      sources: sourcesWith({ history: [...journaled, call(13, 'c6'), output(14, 'c6', 'g'.repeat(2400))] }),
      evicted: new Set(handles.keys()),
      level: 1,
    });
    const before = wholeCounts();
    const second = await buildContext(appendedInput, ports);
    expect(second.evictions).toEqual([]);
    expect(wholeCounts() - before).toBe(1);

    const unchanged = wholeCounts();
    const third = await buildContext(appendedInput, ports);
    expect(third.input).toEqual(second.input);
    expect(wholeCounts() - unchanged).toBe(0);
  });
});
