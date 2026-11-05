import { describe, expect, it } from 'vitest';
import { PinnedOverflowError, PinnedRoomError, buildContext, inputCeilingFor, measurePinned } from '@momonga/context';
import type { BuildContextInput, HistoryItem } from '@momonga/context';
import { summaryItemTokensFor } from '@momonga/protocol';
import type { InputItem } from '@momonga/protocol';
import {
  SYSTEM_PROMPT,
  TASK,
  argsCall,
  call,
  capabilitiesFor,
  fakeCounter,
  handleOf,
  harness,
  inputFor,
  omittedMarker,
  output,
  outputTextOf,
  overflowOf,
  sourcesWith,
  tokensOfItems,
  user,
} from './helpers.ts';
import type { FakeCounter } from './helpers.ts';

const capabilities = capabilitiesFor(4000);

const itemsThrough = (history: readonly HistoryItem[], throughSeq: number) =>
  history.filter((entry) => entry.seq <= throughSeq).map((entry) => entry.item);

const tailAfterTwoSteps = (tailChars: readonly number[], headChars: readonly [number, number] = [930, 930]): HistoryItem[] =>
  [...headChars, ...tailChars].flatMap((chars, index) => [argsCall(2 * index + 1, `c${index}`, chars), output(2 * index + 2, `c${index}`, 'ok')]);

const summaryItemOf = async (input: BuildContextInput): Promise<number> =>
  summaryItemTokensFor((await measurePinned(input, harness(capabilities).ports)).summaryCap);

describe('forced compaction deficit boundary', () => {
  const forcedInput = (lastStepChars: number) => {
    const history = tailAfterTwoSteps([2300, 2300, 2300, lastStepChars]);
    return { history, input: inputFor(capabilities, { sources: sourcesWith({ history }), level: 0 }) };
  };

  it.for([
    { lastStepChars: 2666, slack: 0 },
    { lastStepChars: 2669, slack: 0 },
  ])('accepts the cut when the region minus the summary item equals the deficit exactly ($lastStepChars)', async ({ lastStepChars, slack }) => {
    const { history, input } = forcedInput(lastStepChars);
    const error = await overflowOf(input, harness(capabilities).ports);
    const deficit = error.inputTokens - error.ceiling;
    const region = tokensOfItems(itemsThrough(history, 4));

    expect(region - (await summaryItemOf(input)) - deficit).toBe(slack);
    expect(error.compactionBlockedBy).toBeUndefined();
    expect(error.compaction?.throughSeq).toBe(4);
  });

  it('blocks the cut with deficit_not_closed when the deficit is one token larger than the region minus the summary item', async () => {
    const { history, input } = forcedInput(2670);
    const error = await overflowOf(input, harness(capabilities).ports);
    const deficit = error.inputTokens - error.ceiling;
    const region = tokensOfItems(itemsThrough(history, 4));

    expect(region - (await summaryItemOf(input)) - deficit).toBe(-1);
    expect(error.compaction).toBeUndefined();
    expect(error.compactionBlockedBy?.reason).toBe('deficit_not_closed');
  });
});

describe('proactive compaction gain boundary', () => {
  const proactiveInput = (secondStepChars: number) => {
    const history = tailAfterTwoSteps([1900, 1900, 1900, 1900], [930, secondStepChars]);
    return { history, input: inputFor(capabilities, { sources: sourcesWith({ history }), level: 0 }) };
  };

  it('hints a compaction when the region is exactly twice the summary item', async () => {
    const { history, input } = proactiveInput(1399);
    const built = await buildContext(input, harness(capabilities).ports);

    expect(tokensOfItems(itemsThrough(history, 4))).toBe(2 * (await summaryItemOf(input)));
    expect(built.compaction?.throughSeq).toBe(4);
  });

  it('gives no hint when the region is one token below twice the summary item', async () => {
    const { history, input } = proactiveInput(1395);
    const built = await buildContext(input, harness(capabilities).ports);

    expect(tokensOfItems(itemsThrough(history, 4))).toBe(2 * (await summaryItemOf(input)) - 1);
    expect(built.compaction).toBeUndefined();
  });
});

describe('high-water mark boundary', () => {
  const systemPrompt = `${SYSTEM_PROMPT}${'x'.repeat(30)}`;
  const floor = tokensOfItems([{ type: 'message', role: 'system', content: systemPrompt }, TASK]);
  const highMark = floor + 0.7 * (inputCeilingFor(capabilities) - floor);

  const historyOf = (oldOutputChars: number): HistoryItem[] => [
    call(1, 'c0'),
    output(2, 'c0', 'z'.repeat(oldOutputChars)),
    ...[1, 2, 3, 4, 5].flatMap((index) => [argsCall(2 * index + 1, `c${index}`, 1100), output(2 * index + 2, `c${index}`, 'ok')]),
  ];

  it('uses an integral high-water mark for this fixture', () => {
    expect(Number.isInteger(highMark)).toBe(true);
  });

  it('neither evicts nor hints a compaction when the context holds exactly the high-water mark', async () => {
    const built = await buildContext(
      inputFor(capabilities, { sources: sourcesWith({ systemPrompt, history: historyOf(1596) }), level: 0 }),
      harness(capabilities).ports,
    );

    expect(built.inputTokens).toBe(highMark);
    expect(built.evictions).toEqual([]);
    expect(built.compaction).toBeUndefined();
  });

  it('evicts the oldest output when the context holds one token more than the high-water mark', async () => {
    const built = await buildContext(
      inputFor(capabilities, { sources: sourcesWith({ systemPrompt, history: historyOf(1597) }), level: 0 }),
      harness(capabilities).ports,
    );

    expect(built.evictions.map((eviction) => eviction.callId)).toEqual(['c0']);
  });
});

describe('level contract', () => {
  const singleStep = () => [argsCall(1, 'c0', 100), output(2, 'c0', 'ok')];

  it.for([-1, 1.5])('throws a RangeError for the level %s', async (level) => {
    const input = inputFor(capabilities, { sources: sourcesWith({ history: singleStep() }), level });

    await expect(buildContext(input, harness(capabilities).ports)).rejects.toBeInstanceOf(RangeError);
  });

  it('resolves a level beyond the last distinct level to the last level and reports its protection', async () => {
    const history = [argsCall(1, 'c0', 20000), output(2, 'c0', 'ok')];
    const error = await overflowOf(inputFor(capabilities, { sources: sourcesWith({ history }), level: 2 }), harness(capabilities).ports);

    expect(error.lastLevel).toBe(true);
    expect(error.level).toBe(0);
    expect(error.protection).toEqual({ keepTurns: 3, keepSteps: 4 });
  });

  it('reports the protection of the level actually used when the levels collapse', async () => {
    const history = [argsCall(1, 'c0', 20000), output(2, 'c0', 'ok')];
    const error = await overflowOf(inputFor(capabilities, { sources: sourcesWith({ history }), level: 0 }), harness(capabilities).ports);

    expect(error.lastLevel).toBe(true);
    expect(error.level).toBe(0);
    expect(error.protection).toEqual({ keepTurns: 3, keepSteps: 4 });
  });

  it('reports the reduced protection at the last distinct level of a longer history', async () => {
    const history = tailAfterTwoSteps([2300, 2300, 2300, 2300]);
    const error = await overflowOf(inputFor(capabilities, { sources: sourcesWith({ history }), level: 1 }), harness(capabilities).ports);

    expect(error.lastLevel).toBe(true);
    expect(error.protection).toEqual({ keepTurns: 1, keepSteps: 1 });
  });
});

describe('pinned tokens supplied by the caller', () => {
  it.for([false, true])('are an admitted floor that no build re-checks against the ceiling (observed capacity %s)', async (observed) => {
    const input = inputFor(capabilities, { pinnedTokens: inputCeilingFor(capabilities) + 1, ...(observed ? { observedCapacity: true as const } : {}) });
    const built = await buildContext(input, harness(capabilities).ports);

    expect(built.pinnedTokens).toBe(inputCeilingFor(capabilities) + 1);
  });

  it('raise a pinned overflow when the same pinned part is measured without a supplied value', async () => {
    const input = inputFor(capabilities, { sources: sourcesWith({ systemPrompt: 'x'.repeat(4 * (inputCeilingFor(capabilities) + 1)) }) });
    const error = await buildContext(input, harness(capabilities).ports).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PinnedOverflowError);
    expect(error).not.toBeInstanceOf(PinnedRoomError);
  });
});

describe('compaction cut assertion', () => {
  it('throws when the history before the chosen cut holds an unpaired call', async () => {
    const history = [call(1, 'lost'), user(2, 'next question'), ...[3000, 2100, 2100, 2100, 2100].flatMap((chars, index) => [argsCall(3 + 2 * index, `c${index}`, chars), output(4 + 2 * index, `c${index}`, 'ok')])];
    const input = inputFor(capabilities, { sources: sourcesWith({ history }), level: 1 });

    await expect(buildContext(input, harness(capabilities).ports)).rejects.toThrow(/unpaired/);
  });
});

describe('a compaction plan returned below the last level', () => {
  const planHistory = (): HistoryItem[] => [
    ...[0, 1, 2, 3].flatMap((index) => [argsCall(2 * index + 1, `u${index}`, 1000), output(2 * index + 2, `u${index}`, 'abcd'[index]?.repeat(2400) ?? '')]),
    ...[4, 5, 6, 7].flatMap((index) => [argsCall(2 * index + 1, `p${index}`, 2000), output(2 * index + 2, `p${index}`, 'ok')]),
  ];

  it('stores every blob whose handle the plan input names and reports exactly those evictions', async () => {
    const { ports, blobs } = harness(capabilities);
    const error = await overflowOf(inputFor(capabilities, { sources: sourcesWith({ history: planHistory() }), level: 0 }), ports);

    expect(error.lastLevel).toBe(false);
    const planHandles = (error.compaction?.input ?? []).flatMap((item) =>
      item.type === 'function_call_output' ? [omittedMarker.exec(outputTextOf([item], item.call_id) ?? '')?.[2]] : [],
    );
    const named = planHandles.filter((handle): handle is string => handle !== undefined);
    expect(named.length).toBeGreaterThan(0);
    const stored = blobs.puts.map((put) => handleOf(put.text));
    for (const handle of named) expect(stored).toContain(handle);
    expect(error.evictions.map((eviction) => eviction.handle)).toEqual(stored);
    expect(new Set(stored)).toEqual(new Set(named));
  });
});

describe('evictions after the cut of a compaction plan', () => {
  const gappedHistory = (protectedChars: number): HistoryItem[] => {
    const history: HistoryItem[] = [];
    const push = (build: (seq: number) => HistoryItem): void => {
      history.push(build(history.length + 1));
    };
    const step = (callId: string, argChars: number, text: string): void => {
      push((seq) => argsCall(seq, callId, argChars));
      push((seq) => output(seq, callId, text));
    };
    for (const turn of [0, 1, 2, 3, 4]) {
      push((seq) => user(seq, `question ${turn}`));
      if (turn < 2) step(`old${turn}`, 1000, 'xy'[turn]?.repeat(2400) ?? '');
      else if (turn < 4) step(`mid${turn}`, 100, 'ok');
    }
    step('late0', 200, 'm'.repeat(2400));
    step('late1', 200, 'n'.repeat(2400));
    for (const index of [2, 3, 4, 5]) step(`late${index}`, protectedChars, 'ok');
    return history;
  };

  it('neither stores nor reports an eviction that lies after the cut, and stores every handle the plan names', async () => {
    const { ports, blobs, counter } = harness(capabilities);
    const error = await overflowOf(inputFor(capabilities, { sources: sourcesWith({ history: gappedHistory(1700) }), level: 0 }), ports);

    expect(error.level).toBe(0);
    expect(error.lastLevel).toBe(false);
    expect(error.compaction).toBeDefined();
    const withLateOutputs = counter.calls.filter(
      (request) => typeof request.input !== 'string' && ['late0', 'late1'].every((callId) => outputTextOf(request.input as InputItem[], callId) !== undefined),
    );
    const lastCounted = withLateOutputs.at(-1)?.input as InputItem[];
    expect(omittedMarker.exec(outputTextOf(lastCounted, 'late0') ?? '')?.[2]).toBe(handleOf('m'.repeat(2400)));
    expect(omittedMarker.exec(outputTextOf(lastCounted, 'late1') ?? '')?.[2]).toBe(handleOf('n'.repeat(2400)));
    const named = (error.compaction?.input ?? []).flatMap((item) =>
      item.type === 'function_call_output' ? [omittedMarker.exec(outputTextOf([item], item.call_id) ?? '')?.[2]] : [],
    );
    const stored = blobs.puts.map((put) => handleOf(put.text));
    const afterCut = [handleOf('m'.repeat(2400)), handleOf('n'.repeat(2400))];
    expect(named.length).toBeGreaterThan(0);
    for (const handle of named) expect(stored).toContain(handle as string);
    expect(error.evictions.map((eviction) => eviction.handle)).toEqual(stored);
    for (const handle of afterCut) {
      expect(stored).not.toContain(handle);
      expect(error.evictions.map((eviction) => eviction.handle)).not.toContain(handle);
    }
  });
});

describe('the counted request is the sent request', () => {
  const digitCostCounter = (): FakeCounter => {
    const base = fakeCounter();
    return {
      calls: base.calls,
      count: async (request) => {
        const counted = await base.count(request);
        const handleDigits = [...JSON.stringify(request.input).matchAll(/stored as ([0-9a-f]+);/g)].reduce(
          (sum, match) => sum + (match[1] ?? '').replace(/[^0-9]/g, '').length,
          0,
        );
        return { ...counted, input_tokens: counted.input_tokens + 8 * handleDigits };
      },
    };
  };

  const largeOutputs = (): HistoryItem[] =>
    'abcdef'.split('').flatMap((letter, index) => [call(2 * index + 1, `c${index}`), output(2 * index + 2, `c${index}`, letter.repeat(2400))]);

  it('renders the stored handle in every evicted marker and in the counted request', async () => {
    const counter = digitCostCounter();
    const { ports, blobs } = harness(capabilities, { counter });
    const built = await buildContext(inputFor(capabilities, { sources: sourcesWith({ history: largeOutputs() }), level: 0 }), ports);

    expect(built.evictions.map((eviction) => eviction.handle)).toEqual([handleOf('a'.repeat(2400)), handleOf('b'.repeat(2400))]);
    for (const callId of ['c0', 'c1']) expect(omittedMarker.exec(outputTextOf(built.input, callId) ?? '')?.[2]).toBe(handleOf(`${callId === 'c0' ? 'a' : 'b'}`.repeat(2400)));
    expect(blobs.puts.map((put) => handleOf(put.text))).toEqual(built.evictions.map((eviction) => eviction.handle));
    expect(counter.calls.some((request) => JSON.stringify(request.input) === JSON.stringify(built.input))).toBe(true);
  });

  it('reports the same token count for the returned input as the meter charges for it', async () => {
    const counter = digitCostCounter();
    const { ports } = harness(capabilities, { counter });
    const built = await buildContext(inputFor(capabilities, { sources: sourcesWith({ history: largeOutputs() }), level: 0 }), ports);

    expect((await counter.count({ model: 'test-model', input: built.input, tools: [] })).input_tokens).toBe(built.inputTokens);
  });

  it('stores no blob and reports no eviction for a build that overflows before the last level and finds no compaction plan', async () => {
    const { ports, blobs } = harness(capabilities);
    const history = largeOutputs();
    const error = await overflowOf(inputFor(capabilities, { sources: sourcesWith({ history: [...history, argsCall(13, 'huge', 20000), output(14, 'huge', 'ok')] }), level: 0 }), ports);

    expect(error.lastLevel).toBe(false);
    expect(error.evictions).toEqual([]);
    expect(blobs.puts).toEqual([]);
  });
});
