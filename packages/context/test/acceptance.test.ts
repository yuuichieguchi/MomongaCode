import { describe, expect, it } from 'vitest';
import { ContextOverflowError, buildContext } from '@momonga/context';
import type { HistoryItem } from '@momonga/context';
import type { InputItem } from '@momonga/protocol';
import {
  TASK,
  buildThroughLevels,
  call,
  capabilitiesFor,
  expectPairsWhole,
  handleOf,
  harness,
  inputFor,
  omittedMarker,
  output,
  outputTextOf,
  seeded,
  sourcesWith,
  tokensOfItems,
  truncatedMarker,
  user,
} from './helpers.ts';

describe('acceptance (a) precursor', () => {
  it('keeps a 20k-character current-step tool output within I at W=1024 by storing it behind a handle', async () => {
    const capabilities = capabilitiesFor(1024);
    const { ports, blobs } = harness(capabilities);
    const huge = Array.from({ length: 2000 }, (_, index) => `line ${String(index).padStart(4, '0')}\n`).join('');
    expect(huge.length).toBe(20000);
    const history = [call(1, 'read-1'), output(2, 'read-1', huge)];
    const result = await buildContext(inputFor(capabilities, { sources: sourcesWith({ history }) }), ports);
    expect(result.budget).toEqual({ W: 1024, R: 256, margin: 32, I: 736 });
    expect(result.inputTokens).toBe(tokensOfItems(result.input));
    expect(result.inputTokens).toBeLessThanOrEqual(736);
    expect(blobs.puts).toEqual([{ text: huge, mediaType: expect.any(String) }]);
    const text = outputTextOf(result.input, 'read-1') ?? '';
    expect(truncatedMarker.exec(text)?.[2]).toBe(handleOf(huge));
    expect(result.evictions).toEqual([{ callId: 'read-1', handle: handleOf(huge), kind: 'truncated' }]);
    expect(expectPairsWhole(result.input)).toBe(true);
  });
});

const randomSteps = (random: ReturnType<typeof seeded>): { history: HistoryItem[]; lastStepOutputs: string[] } => {
  const history: HistoryItem[] = [];
  let seq = 1;
  let callNumber = 0;
  let lastStepOutputs: string[] = [];
  const turns = random.int(1, 2);
  for (let turn = 0; turn < turns; turn += 1) {
    if (turn > 0) history.push(user(seq++, 'u'.repeat(random.int(1, 30))));
    const steps = random.int(1, 6);
    for (let step = 0; step < steps; step += 1) {
      const width = random.int(1, 2);
      const ids = Array.from({ length: width }, () => `c${(callNumber += 1)}`);
      for (const id of ids) history.push(call(seq++, id));
      for (const id of ids) history.push(output(seq++, id, 'o'.repeat(random.next() < 0.3 ? random.int(2000, 12000) : random.int(1, 1500))));
      lastStepOutputs = ids;
    }
  }
  return { history, lastStepOutputs };
};

const stepEndSeqs = (history: readonly HistoryItem[]): Set<number> => {
  const ends = new Set<number>();
  for (const [index, entry] of history.entries()) {
    const next = history[index + 1];
    if (entry.item.type === 'function_call_output' && (next === undefined || next.item.type !== 'function_call_output')) ends.add(entry.seq);
  }
  return ends;
};

describe('within-turn property', () => {
  it('builds every random history at some level, fits, keeps the last step and only cuts at step ends', async () => {
    const random = seeded(23);
    const cases = 60;
    let built = 0;
    for (let index = 0; index < cases; index += 1) {
      const capabilities = capabilitiesFor([4000, 8000, 16000][random.int(0, 2)] as number);
      const { history, lastStepOutputs } = randomSteps(random);
      const input = inputFor(capabilities, { sources: sourcesWith({ history }) });
      try {
        const { built: result, level } = await buildThroughLevels(input, harness(capabilities).ports);
        built += 1;
        expect(result.inputTokens).toBe(tokensOfItems(result.input));
        expect(result.inputTokens).toBeLessThanOrEqual(result.budget.I);
        expect(expectPairsWhole(result.input)).toBe(true);
        expect(result.input.filter((item) => JSON.stringify(item) === JSON.stringify(TASK))).toHaveLength(1);
        for (const callId of lastStepOutputs) expect(omittedMarker.test(outputTextOf(result.input, callId) ?? '')).toBe(false);
        const again = await buildContext({ ...input, level }, harness(capabilities).ports);
        expect(again.input).toEqual(result.input);
        if (result.compaction !== undefined) {
          expect(level).toBe(0);
          expect(stepEndSeqs(history).has(result.compaction.throughSeq)).toBe(true);
          expect(expectPairsWhole(result.compaction.input.filter((item: InputItem) => item.type !== 'message'))).toBe(true);
        }
      } catch (error) {
        expect(error).toBeInstanceOf(ContextOverflowError);
        const overflow = error as ContextOverflowError;
        expect(overflow.lastLevel).toBe(true);
        if (overflow.compaction !== undefined) expect(stepEndSeqs(history).has(overflow.compaction.throughSeq)).toBe(true);
      }
    }
    expect(built).toBeGreaterThanOrEqual(cases * 0.75);
  });
});
