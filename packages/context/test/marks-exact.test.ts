import { describe, expect, it } from 'vitest';
import { COMPACT_AT, EVICT_LOW_WATER, floorRatio, summaryItemTokensFor, summaryTokenCapFor } from '@momonga/protocol';
import type { Capabilities, InputItem } from '@momonga/protocol';
import { buildContext, inputCeilingFor } from '@momonga/context';
import type { HistoryItem } from '@momonga/context';
import { HOME, RAW_OUTPUT_TOOL, MODEL, PROJECT, SYSTEM_PROMPT, TASK, assistant, call, capabilitiesFor, fakeBlobs, fakeReader, output, sourcesWith, user } from './helpers.ts';
import { weightMeter, weightOf, weightOfAll } from './weight-meter.ts';

const systemItem: InputItem = { type: 'message', role: 'system', content: SYSTEM_PROMPT };
const floorTokens = weightOf(systemItem) + weightOf(TASK);

const portsWith = (meter = weightMeter()) => ({ meter, blobs: fakeBlobs(), instructions: fakeReader() });

const buildWith = (capabilities: Capabilities, history: HistoryItem[], extra: Partial<Parameters<typeof buildContext>[0]> = {}) =>
  buildContext(
    {
      capabilities,
      model: MODEL,
      sources: sourcesWith({ history }),
      evicted: new Set<string>(),
      recordedReferences: new Set<string>(),
      touchedPaths: [],
      trusted: true,
      projectRoot: PROJECT,
      home: HOME,
      harnessOutputTools: [RAW_OUTPUT_TOOL],
      keepRecentTurns: 1,
      ...extra,
    },
    portsWith(),
  );

const exactHighMark = (capabilities: Capabilities): number => floorTokens + floorRatio(COMPACT_AT, inputCeilingFor(capabilities) - floorTokens);

const floatDisagreeingWindow = (): Capabilities => {
  for (let window = 4000; window < 400_000; window += 1) {
    const capabilities = capabilitiesFor(window, { maxOutputTokens: 1024 });
    const room = inputCeilingFor(capabilities) - floorTokens;
    if ((7 * room) % 10 !== 0) continue;
    if (floorTokens + 0.7 * room < floorTokens + (7 * room) / 10) return capabilities;
  }
  throw new Error('no window where the floating-point high mark falls below the exact one');
};

const OLD_OUTPUT = 'o'.repeat(300);

const historyTotalling = (target: number): HistoryItem[] => {
  const fixed = [user(1, 'old question'), call(2, 'c1'), output(3, 'c1', OLD_OUTPUT), assistant(4, 'old answer')];
  const empty = user(5, '');
  const pad = target - floorTokens - weightOfAll(fixed.map((entry) => entry.item)) - weightOf(empty.item);
  if (pad < 0) throw new Error(`target ${target} is below the fixed history`);
  return [...fixed, user(5, 'p'.repeat(pad))];
};

describe('the high mark is exact integer arithmetic (0.2 #7)', () => {
  it('does not evict at a total equal to F + floor(7·room/10) where the float product rounds below it', async () => {
    const capabilities = floatDisagreeingWindow();
    const highMark = exactHighMark(capabilities);
    const history = historyTotalling(highMark);

    const built = await buildWith(capabilities, history);

    expect(built.evictions).toEqual([]);
    expect(built.inputTokens).toBe(highMark);
  });

  it('evicts the old output once the total is one token above the exact high mark', async () => {
    const capabilities = floatDisagreeingWindow();
    const highMark = exactHighMark(capabilities);
    const history = historyTotalling(highMark + 1);

    const built = await buildWith(capabilities, history);

    expect(built.evictions.map((eviction) => eviction.callId)).toEqual(['c1']);
  });
});

const exactLowMark = (capabilities: Capabilities): number => {
  const highMark = exactHighMark(capabilities);
  return floorTokens + floorRatio(EVICT_LOW_WATER, highMark - floorTokens);
};

const lowMarkDisagreeingWindow = (): Capabilities => {
  for (let window = 4000; window < 400_000; window += 1) {
    const capabilities = capabilitiesFor(window, { maxOutputTokens: 1024 });
    const room = inputCeilingFor(capabilities) - floorTokens;
    const floatHigh = floorTokens + 0.7 * room;
    if (floorTokens + 0.5 * (floatHigh - floorTokens) < exactLowMark(capabilities) && floatHigh < exactHighMark(capabilities)) return capabilities;
  }
  throw new Error('no window where the floating-point low mark falls below the exact one');
};

const FIRST_TEXT = 'a'.repeat(800);

const threeOutputHistory = (secondText: string, pad: number): HistoryItem[] => [
  user(1, 'old question'),
  call(2, 'c1'),
  output(3, 'c1', FIRST_TEXT),
  call(4, 'c2'),
  output(5, 'c2', secondText),
  call(6, 'c3'),
  output(7, 'c3', 'q'.repeat(400)),
  assistant(8, 'old answer'),
  user(9, 'p'.repeat(pad)),
];

const savingOf = async (capabilities: Capabilities, secondText: string): Promise<number> => {
  const history = threeOutputHistory(secondText, 0);
  const built = await buildWith(capabilities, history, { evicted: new Set(['c1', 'c2']) });
  const omitted = built.input.filter((entry) => entry.type === 'function_call_output' && entry.call_id !== 'c3');
  return weightOf(history[2]!.item) + weightOf(history[4]!.item) - weightOfAll(omitted);
};

describe('the low mark is exact integer arithmetic (0.2 #7, baseline λ = 1/2)', () => {
  it('stops evicting once the total equals F + floor((H − F)/2)', async () => {
    const capabilities = lowMarkDisagreeingWindow();
    const highMark = exactHighMark(capabilities);
    const lowMark = exactLowMark(capabilities);
    const saving = highMark + 1 - lowMark;
    let secondText = 'b'.repeat(saving - FIRST_TEXT.length);
    for (let round = 0; round < 4; round += 1) {
      const gap = saving - (await savingOf(capabilities, secondText));
      secondText = 'b'.repeat(secondText.length + gap);
    }
    expect(await savingOf(capabilities, secondText)).toBe(saving);
    const unpadded = threeOutputHistory(secondText, 0);
    const pad = highMark + 1 - floorTokens - weightOfAll(unpadded.map((entry) => entry.item));
    const history = threeOutputHistory(secondText, pad);
    expect(floorTokens + weightOfAll(history.map((entry) => entry.item))).toBe(highMark + 1);

    const built = await buildWith(capabilities, history);

    expect(built.evictions.map((eviction) => eviction.callId)).toEqual(['c1', 'c2']);
    expect(built.inputTokens).toBe(lowMark);
  });
});

const W = 8000;
const proactiveCapabilities = capabilitiesFor(W, { maxOutputTokens: 1024 });
const roomLeft = inputCeilingFor(proactiveCapabilities) - floorTokens;
const summaryItemTokens = summaryItemTokensFor(summaryTokenCapFor(proactiveCapabilities, roomLeft));

const messageOfWeight = (seq: number, role: 'user' | 'assistant', weight: number): HistoryItem => {
  const make = role === 'user' ? user : assistant;
  const pad = weight - weightOf(make(seq, '').item);
  if (pad < 0) throw new Error(`weight ${weight} is below an empty ${role} message`);
  return make(seq, 'x'.repeat(pad));
};

const summaryOfWeight = (weight: number) => {
  const empty: InputItem = { type: 'message', role: 'user', content: '' };
  return { item: { type: 'message' as const, role: 'user' as const, content: 's'.repeat(weight - weightOf(empty)) }, replacedThroughSeq: 0 };
};

const proactiveCase = (newHistory: number) => {
  const previousSummary = 2 * summaryItemTokens;
  const summary = summaryOfWeight(previousSummary);
  const oldUser = messageOfWeight(1, 'user', newHistory - weightOf(assistant(2, 'a').item));
  const oldTurn = [oldUser, assistant(2, 'a')];
  const highMark = floorTokens + floorRatio(COMPACT_AT, roomLeft);
  const currentUser = user(3, 'now');
  const currentTotal = highMark + 1 - floorTokens - previousSummary - newHistory - weightOf(currentUser.item);
  const history = [...oldTurn, currentUser, messageOfWeight(4, 'assistant', currentTotal)];
  return { history, summary, highMark };
};

describe('proactive acceptance needs one summary item of new history (0.2 #25, B5)', () => {
  it('declines a region of at least 2·item whose new history is below one item', async () => {
    const newHistory = summaryItemTokens - 1;
    const { history, summary, highMark } = proactiveCase(newHistory);
    expect(previousSummaryPlus(newHistory)).toBeGreaterThanOrEqual(2 * summaryItemTokens);

    const built = await buildContext(
      {
        capabilities: proactiveCapabilities,
        model: MODEL,
        sources: sourcesWith({ history, summary }),
        evicted: new Set<string>(),
        recordedReferences: new Set<string>(),
        touchedPaths: [],
        trusted: true,
        projectRoot: PROJECT,
        home: HOME,
        harnessOutputTools: [RAW_OUTPUT_TOOL],
        keepRecentTurns: 1,
      },
      portsWith(),
    );

    expect(built.inputTokens).toBe(highMark + 1);
    expect(built.compaction).toBeUndefined();
  });

  it('accepts the same region once its new history reaches one item', async () => {
    const newHistory = summaryItemTokens;
    const { history, summary, highMark } = proactiveCase(newHistory);

    const built = await buildContext(
      {
        capabilities: proactiveCapabilities,
        model: MODEL,
        sources: sourcesWith({ history, summary }),
        evicted: new Set<string>(),
        recordedReferences: new Set<string>(),
        touchedPaths: [],
        trusted: true,
        projectRoot: PROJECT,
        home: HOME,
        harnessOutputTools: [RAW_OUTPUT_TOOL],
        keepRecentTurns: 1,
      },
      portsWith(),
    );

    expect(built.inputTokens).toBe(highMark + 1);
    expect(built.compaction?.throughSeq).toBe(2);
  });
});

const previousSummaryPlus = (newHistory: number): number => 2 * summaryItemTokens + newHistory;
