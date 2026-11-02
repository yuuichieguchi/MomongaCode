import { describe, expect, it } from 'vitest';
import { ContextOverflowError, PinnedOverflowError, buildContext, budgetFor as productBudgetFor } from '@momonga/context';
import {
  assistant,
  budgetFor,
  buildThroughLevels,
  call,
  capabilitiesFor,
  harness,
  inputFor,
  itemCapFor,
  output,
  seeded,
  sourcesWith,
  tokensOfItems,
  tokensOfTools,
  user,
  READ_TOOL,
} from './helpers.ts';
import type { HistoryItem } from '@momonga/context';

describe('budget formula', () => {
  it('reserves 256 output tokens at W=1024 and leaves I = 1024 - 256 - 32', async () => {
    const capabilities = capabilitiesFor(1024);
    const { ports } = harness(capabilities);
    const result = await buildContext(inputFor(capabilities), ports);
    expect(result.budget).toEqual({ W: 1024, R: 256, margin: 32, I: 736 });
    expect(result.maxOutputTokens).toBe(256);
  });

  it('caps R at maxOutputTokens and uses 2% margin for large windows', async () => {
    const capabilities = capabilitiesFor(200000, { maxOutputTokens: 8192 });
    const { ports } = harness(capabilities);
    const result = await buildContext(inputFor(capabilities), ports);
    expect(result.budget).toEqual({ W: 200000, R: 8192, margin: 4000, I: 187808 });
    expect(result.maxOutputTokens).toBe(8192);
  });

  it('uses a quarter of the window when maxOutputTokens is larger', async () => {
    const capabilities = capabilitiesFor(100000, { maxOutputTokens: 100000 });
    const { ports } = harness(capabilities);
    const result = await buildContext(inputFor(capabilities), ports);
    expect(result.budget).toEqual({ W: 100000, R: 25000, margin: 2000, I: 73000 });
  });

  it('caps R at half the window for small windows', () => {
    expect(productBudgetFor(capabilitiesFor(300), 0)).toEqual({ W: 300, R: 150, margin: 32, I: 118 });
  });

  it('adds the counter error_bound to the margin', async () => {
    const capabilities = capabilitiesFor(1024);
    const { ports } = harness(capabilities, { counterErrorBound: 17 });
    const result = await buildContext(inputFor(capabilities), ports);
    expect(result.budget).toEqual({ W: 1024, R: 256, margin: 49, I: 719 });
  });

  it('adds at least a 10% error bound to the margin in estimated mode without observations', async () => {
    const capabilities = capabilitiesFor(1024, { tokenCounting: 'estimated' });
    const { ports } = harness(capabilities);
    const result = await buildContext(inputFor(capabilities), ports);
    expect(result.budget.margin).toBeGreaterThanOrEqual(32 + Math.ceil(0.1 * result.inputTokens));
    expect(result.budget.margin).toBeGreaterThan(32);
    expect(result.budget.I).toBe(1024 - 256 - result.budget.margin);
  });
});

describe('pinned overflow', () => {
  it('throws PinnedOverflowError when pinned alone exceeds I', async () => {
    const capabilities = capabilitiesFor(1024);
    const { ports } = harness(capabilities);
    const sources = sourcesWith({ systemPrompt: 's'.repeat(4000) });
    const error = await buildContext(inputFor(capabilities, { sources }), ports).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PinnedOverflowError);
    const pinned = error as PinnedOverflowError;
    expect(pinned.ceiling).toBe(736);
    expect(pinned.pinnedTokens).toBeGreaterThan(736);
    expect(pinned.pinnedTokens).toBeGreaterThanOrEqual(1000);
  });

  it('throws PinnedOverflowError for a window too small to be usable', async () => {
    const capabilities = capabilitiesFor(64);
    const { ports } = harness(capabilities);
    const error = await buildContext(inputFor(capabilities), ports).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PinnedOverflowError);
    expect((error as PinnedOverflowError).ceiling).toBe(0);
  });
});

const randomHistory = (random: ReturnType<typeof seeded>, inputBudget: number): HistoryItem[] => {
  const history: HistoryItem[] = [];
  let seq = 1;
  let callNumber = 0;
  const turns = random.int(0, 8);
  for (let turn = 0; turn <= turns; turn += 1) {
    const isCurrent = turn === turns;
    history.push(user(seq++, 'u'.repeat(random.int(1, 40))));
    const steps = isCurrent ? random.int(0, 2) : random.int(0, 4);
    for (let step = 0; step < steps; step += 1) {
      callNumber += 1;
      const callId = `c${callNumber}`;
      history.push(call(seq++, callId));
      const size = random.next() < 0.3 ? random.int(1, inputBudget * 8) : random.int(1, 400);
      history.push(output(seq++, callId, 'o'.repeat(size), random.next() < 0.5 ? `pre-${callId}` : undefined));
    }
    if (!isCurrent) history.push(assistant(seq++, 'a'.repeat(random.int(1, 80))));
  }
  return history;
};

describe('budget property', () => {
  it('never returns counted input above I over random histories', async () => {
    const random = seeded(19);
    let built = 0;
    const cases = 120;
    for (let index = 0; index < cases; index += 1) {
      const contextWindow = random.int(600, 200000);
      const maxOutputTokens = random.int(64, 32000);
      const capabilities = capabilitiesFor(contextWindow, { maxOutputTokens });
      const expected = budgetFor(contextWindow, maxOutputTokens);
      expect(itemCapFor(expected.I)).toBeGreaterThanOrEqual(64);
      const { ports } = harness(capabilities);
      const history = randomHistory(random, expected.I);
      const keepRecentTurns = random.int(1, 3);
      try {
        const { built: result } = await buildThroughLevels(
          inputFor(capabilities, { sources: sourcesWith({ history }), keepRecentTurns }),
          ports,
        );
        built += 1;
        expect(result.budget).toEqual(expected);
        expect(result.inputTokens).toBe(tokensOfItems(result.input));
        expect(result.inputTokens).toBeLessThanOrEqual(result.budget.I);
      } catch (error) {
        expect(error).toBeInstanceOf(ContextOverflowError);
        expect((error as ContextOverflowError).inputTokens).toBeGreaterThan(expected.I);
      }
    }
    expect(built).toBeGreaterThanOrEqual(cases * 0.75);
  });
});

describe('tool definitions in the budget', () => {
  const bigTool = { ...READ_TOOL, name: 'Huge', description: 'd'.repeat(4000) };

  it('counts tools as part of the input tokens', async () => {
    const capabilities = capabilitiesFor(200000);
    const { ports } = harness(capabilities);
    const tools = [READ_TOOL, bigTool];
    const result = await buildContext(inputFor(capabilities, { sources: sourcesWith({ tools }) }), ports);
    expect(tokensOfTools(tools)).toBeGreaterThan(1000);
    expect(result.inputTokens).toBe(tokensOfItems(result.input) + tokensOfTools(tools));
  });

  it('leaves out tool definitions that alone exceed I, with a notice', async () => {
    const capabilities = capabilitiesFor(1024);
    const { ports } = harness(capabilities);
    const result = await buildContext(inputFor(capabilities, { sources: sourcesWith({ tools: [bigTool] }) }), ports);
    expect(result.tools).toEqual([]);
    expect(result.notices.map((notice) => notice.code)).toContain('tools_dropped');
  });

  it('throws PinnedOverflowError when the prefix exceeds I even without tools', async () => {
    const capabilities = capabilitiesFor(1024);
    const { ports } = harness(capabilities);
    const sources = sourcesWith({ systemPrompt: 's'.repeat(4000), tools: [bigTool] });
    const error = await buildContext(inputFor(capabilities, { sources }), ports).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PinnedOverflowError);
    expect((error as PinnedOverflowError).ceiling).toBe(736);
    expect((error as PinnedOverflowError).pinnedTokens).toBeGreaterThanOrEqual(tokensOfTools([bigTool]));
  });

  it('leaves less room for history when tools are large, measured above the floor that includes them', async () => {
    const capabilities = capabilitiesFor(4000);
    const history = [user(1, 'old'), call(2, 'c1'), output(3, 'c1', 'o'.repeat(2400)), call(4, 'c2'), output(5, 'c2', 'p'.repeat(2400)), user(6, 'now')];
    const tools = [{ ...bigTool, description: 'd'.repeat(5000) }];
    const without = await buildContext(
      inputFor(capabilities, { sources: sourcesWith({ history }), keepRecentTurns: 1 }),
      harness(capabilities).ports,
    );
    const withTools = await buildContext(
      inputFor(capabilities, { sources: sourcesWith({ history, tools }), keepRecentTurns: 1 }),
      harness(capabilities).ports,
    );
    const floor = 32 + tokensOfTools(tools);
    const highMark = floor + 0.7 * (2920 - floor);
    const lowMark = floor + 0.5 * (highMark - floor);
    expect(without.evictions).toEqual([]);
    expect(withTools.evictions.map((eviction) => eviction.callId)).toEqual(['c1', 'c2']);
    expect(withTools.inputTokens).toBeLessThanOrEqual(lowMark);
  });
});
