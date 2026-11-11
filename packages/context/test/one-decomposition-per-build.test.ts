import { describe, expect, it } from 'vitest';
import { ESTIMATED_ERROR_SHAPE, summaryTokenCapFor } from '@momonga/protocol';
import type { InputItem, MessageInputItem } from '@momonga/protocol';
import { MIN_ROOM_TOKENS, PinnedRoomError, buildContext, capacityFor, createTokenMeter, inputCeilingFor, itemCapFor, measurePinned } from '@momonga/context';
import type { BuildContextInput, BuildContextPorts, HistoryItem, MeterCount, TokenMeter } from '@momonga/context';
import { HOME, RAW_OUTPUT_TOOL, MODEL, PROJECT, TASK, assistant, call, capabilitiesFor, fakeBlobs, fakeReader, output, shapeCounter, sourcesWith, tokensOfItem, truncatedMarker } from './helpers.ts';
import { TEST_FENCE } from '@momonga/testkit';

const WINDOW = 8192;
const OUTPUT = 1024;
const INPUT_BUDGET = 7004;
const STATIC_CEILING = 5387;
const REPORTED = 4600;
const SPLIT_CAPACITY_AT_REPORTED = 6449;

const sized = capabilitiesFor(WINDOW, { tokenCounting: 'estimated', maxOutputTokens: OUTPUT });

const splitCapacityOver = (known: number): number => {
  let largest = 0;
  for (let m = 0; m <= INPUT_BUDGET; m += 1) {
    const added = Math.max(0, m - known);
    const under = added === 0 ? 0 : Math.max(ESTIMATED_ERROR_SHAPE.minimum, Math.ceil(0.3 * added));
    if (m + under <= INPUT_BUDGET) largest = m;
  }
  return largest;
};

type Spied = { meter: TokenMeter; counts: MeterCount[]; renderedItems: InputItem[]; reset(): void };

const spied = (): Spied => {
  const inner = createTokenMeter({ counter: shapeCounter(() => ESTIMATED_ERROR_SHAPE, 'estimated'), model: MODEL, capabilities: sized, observedCapacity: true });
  const counts: MeterCount[] = [];
  const renderedItems: InputItem[] = [];
  const meter: TokenMeter = {
    ...inner,
    count: async (request) => {
      const counted = await inner.count(request);
      counts.push(counted);
      return counted;
    },
    countItem: async (item, context) => {
      renderedItems.push(item);
      return inner.countItem(item, context);
    },
  };
  return {
    meter,
    counts,
    renderedItems,
    reset: () => {
      counts.length = 0;
      renderedItems.length = 0;
    },
  };
};

const inputWith = (history: HistoryItem[], systemPrompt?: string): BuildContextInput => ({
  capabilities: sized,
  model: MODEL,
  sources: sourcesWith({ history, ...(systemPrompt === undefined ? {} : { systemPrompt }) }),
  evicted: new Set<string>(),
  recordedReferences: new Set<string>(),
  touchedPaths: [],
  trusted: true,
  projectRoot: PROJECT,
  home: HOME,
  harnessOutputTools: [RAW_OUTPUT_TOOL],
  keepRecentTurns: 1,
  observedCapacity: true,
  fence: TEST_FENCE,
});

const portsOf = (meter: TokenMeter): BuildContextPorts => ({ meter, blobs: fakeBlobs(), instructions: fakeReader({}) });

describe('one decomposition per build, chosen on the frozen items before the new items are rendered (4.7 Terms; review C-1, C-2)', () => {
  it('has the probe numbers: I0 7004, the static ceiling 5387, and the split C 6449 for a report of 4600', () => {
    expect(inputCeilingFor(sized)).toBe(STATIC_CEILING);
    expect(capacityFor(sized, () => 0)).toBe(INPUT_BUDGET);
    expect(splitCapacityOver(REPORTED)).toBe(SPLIT_CAPACITY_AT_REPORTED);
  });

  it('gives every count of the build after a report the C of one decomposition, the split, and never the static ceiling', async () => {
    const spy = spied();
    const first = [assistant(1, 'a'.repeat(18_300))];
    const built = await buildContext(inputWith(first), portsOf(spy.meter));
    spy.meter.observe({ inputDigest: built.inputDigest, inputTokens: REPORTED });
    spy.reset();

    const next = await buildContext(inputWith([...first, assistant(2, 'b'.repeat(1_200))]), portsOf(spy.meter));

    expect(spy.counts.length).toBeGreaterThan(0);
    const capacities = spy.counts.map((counted) => capacityFor(sized, counted.underAt));
    expect(new Set(capacities)).toEqual(new Set([SPLIT_CAPACITY_AT_REPORTED]));
    expect(capacities).not.toContain(STATIC_CEILING);
    expect(spy.counts.find((counted) => counted.inputDigest === next.inputDigest)?.known).toBe(REPORTED);
  });

  it('measures the admission head at the C of the build decomposition after a report, not at the static ceiling', async () => {
    const spy = spied();
    const first = [assistant(1, 'a'.repeat(18_300))];
    const built = await buildContext(inputWith(first), portsOf(spy.meter));
    spy.meter.observe({ inputDigest: built.inputDigest, inputTokens: REPORTED });

    const measured = await measurePinned(inputWith([...first, assistant(2, 'b'.repeat(1_200))]), portsOf(spy.meter));

    expect(measured.ceiling).toBe(SPLIT_CAPACITY_AT_REPORTED);
    expect(measured.room).toBe(SPLIT_CAPACITY_AT_REPORTED - measured.pinnedTokens);
    expect(measured.itemCap).toBe(itemCapFor(sized, SPLIT_CAPACITY_AT_REPORTED - measured.pinnedTokens));
    expect(measured.summaryCap).toBe(summaryTokenCapFor(sized, SPLIT_CAPACITY_AT_REPORTED - measured.pinnedTokens));
  });

  describe('a pinned prefix that leaves no room under the static ceiling but room under the split C', () => {
    const bigPrompt = 'x'.repeat(21_300);
    const systemMessage: MessageInputItem = { type: 'message', role: 'system', content: bigPrompt };
    const pinned = tokensOfItem(systemMessage) + tokensOfItem(TASK);
    const earlier = assistant(1, 'hello');
    const frozenInput: InputItem[] = [systemMessage, TASK, { type: 'message', id: 'h1', role: 'assistant', content: 'hello' }];

    const reportedMeter = async (): Promise<{ spy: Spied; known: number }> => {
      const spy = spied();
      const counted = await spy.meter.count({ input: frozenInput, tools: [] });
      spy.meter.observe({ inputDigest: counted.inputDigest, inputTokens: counted.inputTokens });
      spy.reset();
      return { spy, known: counted.inputTokens };
    };

    it('is a prefix the static ceiling refuses with PinnedRoomError', async () => {
      expect(STATIC_CEILING - pinned).toBeLessThan(MIN_ROOM_TOKENS);
      const unreported = spied();
      await expect(buildContext(inputWith([earlier], bigPrompt), portsOf(unreported.meter))).rejects.toBeInstanceOf(PinnedRoomError);
    });

    it('admits the prefix after a report, at the split C of the build', async () => {
      const { spy, known } = await reportedMeter();
      const capacity = splitCapacityOver(known);
      expect(capacity - pinned).toBeGreaterThanOrEqual(MIN_ROOM_TOKENS);

      const measured = await measurePinned(inputWith([earlier, assistant(2, 'next')], bigPrompt), portsOf(spy.meter));

      expect(measured.pinnedTokens).toBe(pinned);
      expect(measured.ceiling).toBe(capacity);
      expect(measured.itemCap).toBe(itemCapFor(sized, capacity - pinned));
      expect(measured.summaryCap).toBe(summaryTokenCapFor(sized, capacity - pinned));
    });

  });

  it('renders a new output once, at the item cap of the split C, never first at the item cap of the static ceiling', async () => {
    const prompt = 'x'.repeat(8_000);
    const pinned = tokensOfItem({ type: 'message', role: 'system', content: prompt }) + tokensOfItem(TASK);
    const staticCap = itemCapFor(sized, STATIC_CEILING - pinned);
    const splitCap = itemCapFor(sized, SPLIT_CAPACITY_AT_REPORTED - pinned);
    expect(staticCap).toBeLessThan(splitCap);
    const spy = spied();
    const first = [assistant(1, 'a'.repeat(10_300))];
    const built = await buildContext(inputWith(first, prompt), portsOf(spy.meter));
    spy.meter.observe({ inputDigest: built.inputDigest, inputTokens: REPORTED });
    spy.reset();
    const text = 'r'.repeat(4 * Math.floor((staticCap + splitCap) / 2) - 60);
    const newOutput = output(3, 'c-new', text);
    const outputTokens = tokensOfItem(newOutput.item);
    expect(outputTokens).toBeGreaterThan(staticCap);
    expect(outputTokens).toBeLessThan(splitCap);

    const next = await buildContext(inputWith([...first, call(2, 'c-new'), newOutput], prompt), portsOf(spy.meter));

    const finalOutput = next.input.find((item) => item.type === 'function_call_output' && item.call_id === 'c-new');
    expect(finalOutput?.type === 'function_call_output' ? finalOutput.output : undefined).toBe(text);
    const truncatedRenderings = spy.renderedItems.filter(
      (item) => item.type === 'function_call_output' && item.call_id === 'c-new' && typeof item.output === 'string' && truncatedMarker.test(item.output),
    );
    expect(truncatedRenderings.length).toBe(0);
  });
});
