import { describe, expect, it, vi } from 'vitest';
import { ContextOverflowError, PinnedBoundError, budgetFor, buildContext, createTokenMeter, maxInputFor, measurePinned } from '@momonga/context';
import type { BuildContextPorts, TokenMeter } from '@momonga/context';
import { ESTIMATED_ERROR_SHAPE, countReplyOf, errorBoundOfShape, marginFloorFor, summaryItemTokensFor } from '@momonga/protocol';
import type { Capabilities, ErrorShape, InputItem } from '@momonga/protocol';
import {
  MODEL,
  TASK,
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
  seeded,
  shapeCounter,
  sourcesWith,
} from './helpers.ts';
import type { FakeCounter } from './helpers.ts';
import type { HistoryItem } from '@momonga/context';
import { PROPERTY_TIMEOUT_MS } from '@momonga/testkit';

vi.setConfig({ testTimeout: PROPERTY_TIMEOUT_MS });

const W8192 = capabilitiesFor(8192, { maxOutputTokens: 1024, tokenCounting: 'estimated' });

const argsSteps = (chars: readonly number[]): HistoryItem[] =>
  chars.flatMap((size, index) => [
    { seq: 2 * index + 1, item: { type: 'function_call', id: `h${2 * index + 1}`, call_id: `c${index}`, name: 'Peek', arguments: `{"p":"${'x'.repeat(size)}"}` } },
    output(2 * index + 2, `c${index}`, 'ok'),
  ]);

const portsWith = (meter: TokenMeter): BuildContextPorts => ({ meter, blobs: fakeBlobs(), instructions: fakeReader() });

const meterWithObservedMiss = async (capabilities: Capabilities, counter: FakeCounter, relativeError: number, shapeBound = 0): Promise<TokenMeter> => {
  const meter = createTokenMeter({ counter, model: MODEL, capabilities });
  const unrelated: InputItem = { type: 'message', role: 'user', content: 'u'.repeat(368) };
  const counted = await meter.count({ input: [unrelated], tools: [] });
  expect(counted.inputTokens).toBe(104);
  const observed = meter.observe({ inputDigest: counted.inputDigest, inputTokens: Math.round(104 * (1 + relativeError)) });
  expect(observed.miss).toBe(Math.max(0, Math.round(104 * relativeError) - shapeBound));
  return meter;
};

describe('no ceiling drift between meters', () => {
  it('gives identical marks, caps and cut candidates for a fresh meter and one with a large observed error', async () => {
    const history = argsSteps([2799, 2799, 2799, 2799, 2799, 2798]);
    const input = inputFor(W8192, { sources: sourcesWith({ history }), level: 0 });
    const fresh = createTokenMeter({ counter: fakeCounter(0), model: MODEL, capabilities: W8192 });
    const skewed = await meterWithObservedMiss(W8192, fakeCounter(0), 0.5);

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
    const skewed = await meterWithObservedMiss(W8192, fakeCounter(0), 0.5);

    const built = await buildContext(input, portsWith(fresh));
    const error = await overflowOf(input, portsWith(skewed));

    expect(built.inputTokens).toBe(4928);
    expect(error.inputTokens).toBe(4928);
    expect(error.ceiling).toBe(5387);
    expect(error.inputBudget).toBe(7004 - (2464 - marginFloorFor(8192)));
  });
});

describe('forced deficit against the ceiling and the live bound', () => {
  it.for([
    { label: 'region closes only the live deficit', chars: [2299, 2299, 4971, 4971, 4971, 4970], closes: false },
    { label: 'region closes the deficit against the ceiling', chars: [3499, 3499, 4371, 4371, 4371, 4370], closes: true },
  ])('measures against the ceiling when the live bound is looser: $label', async ({ chars, closes }) => {
    const meter = createTokenMeter({ counter: ratioCounter(0.1), model: MODEL, capabilities: W8192 });
    const error = await overflowOf(inputFor(W8192, { sources: sourcesWith({ history: argsSteps(chars) }), level: 0 }), portsWith(meter));

    expect(error.inputTokens).toBe(6400);
    expect(error.inputBudget).toBe(7004 - 640);
    expect(error.ceiling).toBe(5387);
    if (closes) {
      expect(error.compaction?.throughSeq).toBe(4);
    } else {
      expect(error.compaction).toBeUndefined();
      expect(error.compactionBlockedBy?.reason).toBe('deficit_not_closed');
      expect(error.compactionBlockedBy?.message).toMatch(/, but 1013 are needed$/);
    }
  });

  it.for([
    { label: 'region frees less than the live deficit', chars: [1099, 1099, 4171, 4171, 4171, 4170], closes: false },
    { label: 'region closes the live deficit', chars: [1787, 1699, 3871, 3871, 3871, 3782], closes: true },
  ])('measures against the live bound when the observed excess exceeds the sizing ratio: $label', async ({ chars, closes }) => {
    const floor = marginFloorFor(8192);
    const meter = await meterWithObservedMiss(W8192, fakeCounter(0), 0.5);
    const error = await overflowOf(inputFor(W8192, { sources: sourcesWith({ history: argsSteps(chars) }), level: 0 }), portsWith(meter));

    expect(error.inputTokens).toBe(5000);
    expect(error.inputBudget).toBe(7004 - (2500 - floor));
    if (closes) {
      expect(error.compaction?.throughSeq).toBe(4);
    } else {
      expect(error.compaction).toBeUndefined();
      expect(error.compactionBlockedBy?.reason).toBe('deficit_not_closed');
      expect(error.compactionBlockedBy?.message).toMatch(/, but 222 are needed$/);
    }
  });
});

describe('forced deficit with the gateway bound max(1, ceil(0.3 x tokens))', () => {
  const gatewayCounter = (): FakeCounter => shapeCounter(() => ESTIMATED_ERROR_SHAPE);

  it('compacts the skills e2e state at 6049 tokens: the region frees less than T + bound(T) - I but closes the excess over the ceiling', async () => {
    const meter = createTokenMeter({ counter: gatewayCounter(), model: MODEL, capabilities: W8192 });
    const error = await overflowOf(
      inputFor(W8192, { sources: sourcesWith({ history: argsSteps([2659, 2659, 4442, 4442, 4442, 4445]) }), level: 0 }),
      portsWith(meter),
    );

    const total = error.inputTokens;
    expect(total).toBe(6049);
    expect(error.ceiling).toBe(5387);
    expect(error.inputBudget).toBe(budgetFor(W8192, 0, 0).I - errorBoundOfShape(ESTIMATED_ERROR_SHAPE, total));
    expect(error.compactionBlockedBy).toBeUndefined();
    const plan = error.compaction;
    expect(plan?.throughSeq).toBe(4);
    const planned = (await meter.count({ input: plan?.input ?? [], tools: [] })).inputTokens;
    const task = (await meter.count({ input: [TASK], tools: [] })).inputTokens;
    const freed = planned - task - summaryItemTokensFor(plan?.summaryTokenCap ?? 0);

    expect(freed).toBeLessThan(total + errorBoundOfShape(ESTIMATED_ERROR_SHAPE, total) - budgetFor(W8192, 0, 0).I);
    expect(freed).toBeGreaterThanOrEqual(total - error.ceiling);
  });

  it('evaluates the bound of a fresh count at the size after compaction', async () => {
    const counter = { count: async () => countReplyOf(6049, 'estimated', ESTIMATED_ERROR_SHAPE) };
    const meter = createTokenMeter({ counter, model: MODEL, capabilities: W8192 });
    const counted = await meter.count({ input: [{ type: 'message', role: 'user', content: 'x' }], tools: [] });

    expect(counted.underAt(6049)).toBe(1815);
    expect(counted.freshUnderAt(6049)).toBe(1815);
    expect(counted.freshUnderAt(5387)).toBe(1617);
    expect(counted.freshUnderAt(0)).toBe(0);
    expect(maxInputFor({ ceiling: 5387, inputBudget: budgetFor(W8192, 0, 0).I, errorBoundAt: counted.freshUnderAt })).toBe(5387);
  });

  it('evaluates a suffix count at the bound of its uncounted part, which grows above the known part', async () => {
    const meter = createTokenMeter({ counter: gatewayCounter(), model: MODEL, capabilities: W8192 });
    const head: InputItem = { type: 'message', role: 'user', content: 'h'.repeat(16000) };
    const tail: InputItem = { type: 'message', role: 'user', content: 't'.repeat(400) };
    const observed = await meter.count({ input: [head], tools: [] });
    meter.observe({ inputDigest: observed.inputDigest, inputTokens: observed.inputTokens });
    const counted = await meter.count({ input: [head, tail], tools: [] });
    const part = (tokens: number): number => Math.max(0, tokens - observed.inputTokens);
    const bound = (tokens: number): number => (part(tokens) === 0 ? 0 : errorBoundOfShape(ESTIMATED_ERROR_SHAPE, part(tokens)));

    expect(counted.known).toBe(observed.inputTokens);
    expect(counted.underAt(counted.inputTokens)).toBe(bound(counted.inputTokens));
    expect(counted.underAt(3000)).toBe(bound(3000));
    expect(counted.underAt(6000)).toBe(bound(6000));
  });

  it('compacts a region that closes the excess over the ceiling although it frees less than T + bound(T) - I', async () => {
    const meter = createTokenMeter({ counter: ratioCounter(0.3), model: MODEL, capabilities: W8192 });
    const error = await overflowOf(
      inputFor(W8192, { sources: sourcesWith({ history: argsSteps([3499, 3499, 4371, 4371, 4371, 4370]) }), level: 0 }),
      portsWith(meter),
    );

    expect(error.inputTokens).toBe(6400);
    expect(error.inputBudget).toBe(7004 - 1920);
    expect(error.compactionBlockedBy).toBeUndefined();
    expect(error.compaction?.throughSeq).toBe(4);
  });

  it('adds the observed excess to the shape of the counter, with a deficit above the excess over the ceiling', async () => {
    const floor = marginFloorFor(8192);
    const shapeBound = Math.ceil(0.3 * 104);
    const meter = await meterWithObservedMiss(W8192, ratioCounter(0.3), 0.5, shapeBound);
    const miss = Math.round(104 * 0.5) - shapeBound;
    const bound = (tokens: number): number => Math.ceil(0.3 * tokens) + Math.max(0, Math.ceil(miss * Math.max(1, tokens / 104)) - floor);
    const input = budgetFor(W8192, 0, 0).I;
    const largest = Array.from({ length: 5388 }, (_, tokens) => tokens).filter((tokens) => tokens + bound(tokens) <= input).at(-1) as number;
    const error = await overflowOf(
      inputFor(W8192, { sources: sourcesWith({ history: argsSteps([1099, 1099, 4171, 4171, 4171, 4170]) }), level: 0 }),
      portsWith(meter),
    );

    expect(error.inputTokens).toBe(5000);
    expect(error.ceiling).toBe(5387);
    expect(error.inputBudget).toBe(input - bound(5000));
    expect(error.compactionBlockedBy?.reason).toBe('deficit_not_closed');
    expect(error.compactionBlockedBy?.message).toMatch(new RegExp(`, but ${5000 - largest} are needed$`));
  });
});

describe('maxInputFor over random bounds', () => {
  it('returns the largest size within the ceiling whose own bound fits, so one token more fails', () => {
    const random = seeded(8192);
    let found = 0;
    for (let trial = 0; trial < 4000; trial += 1) {
      const ceiling = random.int(0, 20000);
      const inputBudget = random.int(0, 30000);
      const relative = random.int(0, 150) / 100;
      const counterRatio = random.int(0, 100) / 100;
      const offset = random.int(0, 400);
      const summed = random.next() < 0.5;
      const errorBoundAt = (tokens: number): number =>
        offset + (summed ? Math.ceil(relative * tokens) + Math.ceil(counterRatio * tokens) : Math.max(Math.ceil(relative * tokens), Math.ceil(counterRatio * tokens)));
      const label = JSON.stringify({ ceiling, inputBudget, relative, counterRatio, offset, summed });
      const largest = maxInputFor({ ceiling, inputBudget, errorBoundAt });

      if (largest === undefined) {
        expect(errorBoundAt(0), label).toBeGreaterThan(inputBudget);
        continue;
      }
      found += 1;
      expect(largest, label).toBeGreaterThanOrEqual(0);
      expect(largest, label).toBeLessThanOrEqual(ceiling);
      expect(largest + errorBoundAt(largest), label).toBeLessThanOrEqual(inputBudget);
      const oneMore = largest + 1;
      expect(oneMore > ceiling || oneMore + errorBoundAt(oneMore) > inputBudget, label).toBe(true);
    }
    expect(found).toBeGreaterThan(3000);
  });

  it('returns undefined when even an empty input does not fit its bound', () => {
    expect(maxInputFor({ ceiling: 5387, inputBudget: 7004, errorBoundAt: (tokens) => 7005 + Math.ceil(0.3 * tokens) })).toBeUndefined();
    expect(maxInputFor({ ceiling: 5387, inputBudget: -1, errorBoundAt: () => 0 })).toBeUndefined();
    expect(maxInputFor({ ceiling: -1, inputBudget: 7004, errorBoundAt: () => 0 })).toBeUndefined();
    expect(maxInputFor({ ceiling: 0, inputBudget: 0, errorBoundAt: () => 0 })).toBe(0);
  });
});

describe('a counter bound that leaves no room for the pinned context', () => {
  const inputBudget = budgetFor(W8192, 0, 0).I;
  const boundFailureOf = async (historyBound: number): Promise<unknown> => {
    const inner = createTokenMeter({ counter: shapeCounter(() => ESTIMATED_ERROR_SHAPE), model: MODEL, capabilities: W8192 });
    const meter: TokenMeter = {
      ...inner,
      count: async (request) => {
        const counted = await inner.count(request);
        return request.input.length > 2 ? { ...counted, underAt: () => historyBound, freshUnderAt: () => historyBound } : counted;
      },
    };
    return buildContext(inputFor(W8192, { sources: sourcesWith({ history: argsSteps([400, 400, 400, 400, 400, 400]) }), level: 0 }), portsWith(meter)).catch(
      (caught: unknown) => caught,
    );
  };

  it('fails before planning a compaction when even an empty input exceeds the budget with its bound', async () => {
    const error = await boundFailureOf(inputBudget + 1);

    expect(error).toBeInstanceOf(PinnedBoundError);
    expect(error).not.toBeInstanceOf(ContextOverflowError);
    const failure = error as PinnedBoundError;
    expect(failure.ceiling).toBe(5387);
    expect(failure.inputBudget).toBe(inputBudget);
    expect(failure.boundAtZero).toBe(inputBudget + 1);
    expect(failure.maxInput).toBeUndefined();
    expect(failure.message).toBe(
      `no input size fits: the token counter's error bound is ${inputBudget + 1} tokens even for an empty input, more than the input budget of ${inputBudget}; raise contextWindow, lower maxOutputTokens, or calibrate the token counter`,
    );
  });

  it('fails the same way when the largest size that fits with its bound is below the pinned tokens', async () => {
    const error = await boundFailureOf(inputBudget - 10);

    expect(error).toBeInstanceOf(PinnedBoundError);
    const failure = error as PinnedBoundError;
    expect(failure.ceiling).toBe(5387);
    expect(failure.maxInput).toBe(10);
    expect(failure.pinnedTokens).toBeGreaterThan(10);
    expect(failure.message).toBe(
      `the pinned context needs ${failure.pinnedTokens} tokens, but with the token counter's error bound at most 10 fit the input budget of ${inputBudget}; raise contextWindow, lower maxOutputTokens, or calibrate the token counter`,
    );
  });
});

describe('accepted counts stay within I with the meter\'s own bound', () => {
  it('keeps every accepted build at or below budgetFor(capabilities, 0).I including the bound the meter returns', async () => {
    const capabilities = capabilitiesFor(4096, { maxOutputTokens: 1024, tokenCounting: 'estimated' });
    const I = budgetFor(capabilities, 0, 0).I;
    expect(I).toBe(2990);
    const meter = createTokenMeter({ counter: ratioCounter(0.3), model: MODEL, capabilities });
    const ports = portsWith(meter);
    const history: HistoryItem[] = [...'abcdef'].flatMap((letter, index) => [call(2 * index + 1, `c${index}`), output(2 * index + 2, `c${index}`, letter.repeat(2400))]);

    const first = await buildThroughLevels(inputFor(capabilities, { sources: sourcesWith({ history }) }), ports);
    expect(first.level).toBe(1);
    expect(first.built.inputTokens).toBe(952);
    const firstCount = await meter.count({ input: first.built.input, tools: first.built.tools });
    expect(first.built.inputTokens + firstCount.underAt(firstCount.inputTokens)).toBeLessThanOrEqual(I);

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
    expect(second.built.inputTokens + secondCount.underAt(secondCount.inputTokens)).toBeLessThanOrEqual(I);
  });
});

describe('meter counts across in-turn builds', () => {
  it('counts an appended step after an eviction batch and an unchanged rebuild with no counter call', async () => {
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
    expect(wholeCounts() - before).toBe(8);

    const unchanged = wholeCounts();
    const third = await buildContext(appendedInput, ports);
    expect(third.input).toEqual(second.input);
    expect(wholeCounts() - unchanged).toBe(0);
  });
});
