import { describe, expect, it } from 'vitest';
import { floorRatio, summaryItemTokensFor, summaryTokenCapFor } from '@momonga/protocol';
import type { InputItem, Ratio } from '@momonga/protocol';
import { ContextOverflowError, buildContext, inputCeilingFor } from '@momonga/context';
import type { BuildContextInput, HistoryItem } from '@momonga/context';
import { HOME, RAW_OUTPUT_TOOL, MODEL, PROJECT, SYSTEM_PROMPT, TASK, assistant, call, capabilitiesFor, fakeBlobs, fakeReader, output, sourcesWith, user, withTurnsBeforeCurrent } from './helpers.ts';
import { weightMeter, weightOf, weightOfAll } from './weight-meter.ts';
import { TEST_FENCE } from '@momonga/testkit';

const systemItem: InputItem = { type: 'message', role: 'system', content: SYSTEM_PROMPT };
const floorTokens = weightOf(systemItem) + weightOf(TASK);
const capabilities = capabilitiesFor(8000, { maxOutputTokens: 1024 });
const ceiling = inputCeilingFor(capabilities);
const room = ceiling - floorTokens;
const summaryItemTokens = summaryItemTokensFor(summaryTokenCapFor(capabilities, room));

const percent = (num: number): Ratio => ({ num, den: 100 });
const highMarkAt = (ratio: Ratio): number => floorTokens + floorRatio(ratio, room);

type Layout = 'plain' | 'cachePrefix';
const LAYOUTS: readonly Layout[] = ['plain', 'cachePrefix'];

const portsWith = () => ({ meter: weightMeter(), blobs: fakeBlobs(), instructions: fakeReader() });

const build = (layout: Layout, sources: BuildContextInput['sources'], compactAt: Ratio | undefined) => {
  const input = {
    reasoningRoom: 0,
    capabilities,
    fence: TEST_FENCE,
    model: MODEL,
    sources,
    evicted: new Set<string>(),
    recordedReferences: new Set<string>(),
    touchedPaths: [],
    trusted: true,
    projectRoot: PROJECT,
    home: HOME,
    harnessOutputTools: [RAW_OUTPUT_TOOL],
    ...(layout === 'cachePrefix' ? { layout: 'cachePrefix' as const } : {}),
    ...(compactAt === undefined ? {} : { compactAt }),
  };
  return buildContext(input as BuildContextInput, portsWith());
};

const OLD_OUTPUT = 'o'.repeat(300);
const outputHistory = (pad: number): HistoryItem[] =>
  withTurnsBeforeCurrent([user(1, 'old question'), call(2, 'c1'), output(3, 'c1', OLD_OUTPUT), assistant(4, 'old answer'), user(5, 'p'.repeat(pad))]);
const outputHistoryTotalling = (target: number): HistoryItem[] => {
  const pad = target - floorTokens - weightOfAll(outputHistory(0).map((entry) => entry.item));
  if (pad < 0) throw new Error(`target ${target} is below the fixed history`);
  return outputHistory(pad);
};
const smallestOutputTotal = floorTokens + weightOfAll(outputHistory(0).map((entry) => entry.item));

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

const compactableSourcesTotalling = (target: number): BuildContextInput['sources'] => {
  const previousSummary = 2 * summaryItemTokens;
  const summary = summaryOfWeight(previousSummary);
  const newHistory = summaryItemTokens;
  const oldTurn = [messageOfWeight(1, 'user', newHistory - weightOf(assistant(2, 'a').item)), assistant(2, 'a')];
  const between = withTurnsBeforeCurrent([...oldTurn, user(3, '')]).slice(oldTurn.length, -1);
  const currentSeq = 3 + between.length;
  const currentUser = user(currentSeq, 'now');
  const currentTotal = target - floorTokens - previousSummary - newHistory - weightOfAll(between.map((entry) => entry.item)) - weightOf(currentUser.item);
  const history = [...oldTurn, ...between, currentUser, messageOfWeight(currentSeq + 1, 'assistant', currentTotal)];
  return sourcesWith({ history, summary });
};

describe.each(LAYOUTS)('context.compactAt moves the high mark (layout %s)', (layout) => {
  describe.each([50, 90])('at %i percent', (p) => {
    const highMark = highMarkAt(percent(p));

    it('evicts nothing at a total equal to F + floor(p·room/100)', async () => {
      const built = await build(layout, sourcesWith({ history: outputHistoryTotalling(highMark) }), percent(p));

      expect(built.evictions).toEqual([]);
      expect(built.inputTokens).toBe(highMark);
    });

    it('evicts the old output one token above F + floor(p·room/100)', async () => {
      const built = await build(layout, sourcesWith({ history: outputHistoryTotalling(highMark + 1) }), percent(p));

      expect(built.evictions.map((eviction) => eviction.callId)).toEqual(['c1']);
    });

    it('offers no proactive plan at a total equal to the mark', async () => {
      const built = await build(layout, compactableSourcesTotalling(highMark), percent(p));

      expect(built.inputTokens).toBe(highMark);
      expect(built.compaction).toBeUndefined();
    });

    it('offers a proactive plan one token above the mark', async () => {
      const built = await build(layout, compactableSourcesTotalling(highMark + 1), percent(p));

      expect(built.inputTokens).toBe(highMark + 1);
      expect(built.compaction?.throughSeq).toBe(2);
    });
  });

  describe('at 1 percent', () => {
    it('evicts the old output from the smallest history that holds it, which the default keeps', async () => {
      expect(smallestOutputTotal).toBeGreaterThan(highMarkAt(percent(1)));
      expect(smallestOutputTotal).toBeLessThanOrEqual(highMarkAt(percent(70)));
      const history = outputHistoryTotalling(smallestOutputTotal);

      const atOne = await build(layout, sourcesWith({ history }), percent(1));
      const atDefault = await build(layout, sourcesWith({ history }), undefined);

      expect(atOne.evictions.map((eviction) => eviction.callId)).toEqual(['c1']);
      expect(atDefault.evictions).toEqual([]);
    });

    it('offers a proactive plan for a compactable region far below the default mark', async () => {
      const target = highMarkAt(percent(50));

      const atOne = await build(layout, compactableSourcesTotalling(target), percent(1));
      const atDefault = await build(layout, compactableSourcesTotalling(target), undefined);

      expect(atOne.compaction?.throughSeq).toBe(2);
      expect(atDefault.compaction).toBeUndefined();
    });
  });

  describe('at 100 percent', () => {
    it('offers no proactive plan at a total equal to the ceiling, where the default offers one', async () => {
      const atHundred = await build(layout, compactableSourcesTotalling(ceiling), percent(100));
      const atDefault = await build(layout, compactableSourcesTotalling(ceiling), undefined);

      expect(atHundred.inputTokens).toBe(ceiling);
      expect(atHundred.compaction).toBeUndefined();
      expect(atDefault.compaction?.throughSeq).toBe(2);
    });

    it('throws the overflow error carrying the forced plan one token above the ceiling', async () => {
      const error = await build(layout, compactableSourcesTotalling(ceiling + 1), percent(100)).then(
        () => undefined,
        (thrown: unknown) => thrown,
      );

      expect(error).toBeInstanceOf(ContextOverflowError);
      expect((error as ContextOverflowError).compaction?.throughSeq).toBe(2);
    });
  });

  describe('when absent', () => {
    const defaultMark = highMarkAt(percent(70));

    it('keeps the history at F + floor(70·room/100) whole', async () => {
      const built = await build(layout, sourcesWith({ history: outputHistoryTotalling(defaultMark) }), undefined);

      expect(built.evictions).toEqual([]);
    });

    it('evicts one token above F + floor(70·room/100) and plans exactly as 70 percent does', async () => {
      const evicting = await build(layout, sourcesWith({ history: outputHistoryTotalling(defaultMark + 1) }), undefined);
      const planned = await build(layout, compactableSourcesTotalling(defaultMark + 1), undefined);
      const plannedAtSeventy = await build(layout, compactableSourcesTotalling(defaultMark + 1), percent(70));
      const quiet = await build(layout, compactableSourcesTotalling(defaultMark), undefined);

      expect(evicting.evictions.map((eviction) => eviction.callId)).toEqual(['c1']);
      expect(planned.compaction?.throughSeq).toBe(2);
      expect(plannedAtSeventy.compaction?.throughSeq).toBe(2);
      expect(quiet.compaction).toBeUndefined();
    });
  });
});
