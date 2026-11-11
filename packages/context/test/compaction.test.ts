import { describe, expect, it } from 'vitest';
import { ContextOverflowError, buildContext, evictionPassFor } from '@momonga/context';
import type { CompactionInputItem } from '@momonga/protocol';
import {
  TASK,
  assistant,
  call,
  capabilitiesFor,
  expectPairsWhole,
  harness,
  idsOf,
  inputFor,
  output,
  overflowOf,
  outputTextOf,
  sourcesWith,
  tokensOfItems,
  user,
} from './helpers.ts';

const W = 4000;
const I = 2920;

describe('proactive compaction hint', () => {
  it('requests compaction through the end of the last non-recent turn when above the high-water mark', async () => {
    const capabilities = capabilitiesFor(W);
    const { ports } = harness(capabilities);
    const history = [
      user(1, 'q1'),
      assistant(2, 'x'.repeat(4400)),
      user(3, 'q2'),
      call(4, 'c1'),
      output(5, 'c1', 'ok'),
      assistant(6, 'y'.repeat(4400)),
      user(7, 'now'),
    ];
    const result = await buildContext(
      inputFor(capabilities, { sources: sourcesWith({ history }), keepRecentTurns: 1 }),
      ports,
    );
    expect(result.inputTokens).toBe(2345);
    expect(result.compaction?.throughSeq).toBe(6);
  });

  it('keeps the default three recent turns out of the compaction range', async () => {
    const capabilities = capabilitiesFor(W);
    const { ports } = harness(capabilities);
    const history = [
      user(1, 'q1'),
      assistant(2, 'x'.repeat(8800)),
      user(3, 'q2'),
      call(4, 'c1'),
      output(5, 'c1', 'ok'),
      user(6, 'q3'),
      assistant(7, 'r3'),
      user(8, 'q4'),
    ];
    const result = await buildContext(inputFor(capabilities, { sources: sourcesWith({ history }) }), ports);
    expect(result.compaction?.throughSeq).toBe(2);
  });

  it('honours a custom compactAt threshold', async () => {
    const capabilities = capabilitiesFor(W);
    const { ports } = harness(capabilities);
    const history = [user(1, 'q1'), assistant(2, 'x'.repeat(4000)), user(3, 'now')];
    const below = await buildContext(
      inputFor(capabilities, { sources: sourcesWith({ history }), keepRecentTurns: 1 }),
      ports,
    );
    expect(below.inputTokens).toBeLessThan(0.7 * I);
    expect(below.inputTokens).toBeGreaterThan(0.3 * I);
    expect(below.compaction).toBeUndefined();
    const above = await buildContext(
      inputFor(capabilities, { sources: sourcesWith({ history }), keepRecentTurns: 1, compactAt: 0.3 }),
      harness(capabilities).ports,
    );
    expect(above.compaction?.throughSeq).toBe(2);
  });

  it('does not request compaction when only recent items remain', async () => {
    const capabilities = capabilitiesFor(W);
    const { ports } = harness(capabilities);
    const history = [user(1, 'now'), assistant(2, 'y'.repeat(9000))];
    const result = await buildContext(inputFor(capabilities, { sources: sourcesWith({ history }) }), ports);
    expect(result.inputTokens).toBeGreaterThan(0.7 * I);
    expect(result.inputTokens).toBeLessThanOrEqual(I);
    expect(result.compaction).toBeUndefined();
  });
});

describe('summary layering', () => {
  const summaryItem: CompactionInputItem = { type: 'compaction', encrypted_content: 'enc-summary-1' };
  const history = [
    user(1, 'q1'),
    call(2, 'c1'),
    output(3, 'c1', 'r1'),
    assistant(4, 'a1'),
    user(5, 'q2'),
    assistant(6, 'a2'),
    user(7, 'q3'),
    call(8, 'c2'),
    output(9, 'c2', 'r2'),
  ];

  it('places the summary after the layers, the task right after the summary that covers it, and drops replaced history', async () => {
    const capabilities = capabilitiesFor(200000);
    const { ports } = harness(capabilities);
    const result = await buildContext(
      inputFor(capabilities, {
        sources: sourcesWith({ history, summary: { item: summaryItem, replacedThroughSeq: 6 } }),
      }),
      ports,
    );
    expect(result.input[1]).toEqual(summaryItem);
    expect(result.input[2]).toEqual(TASK);
    expect(idsOf(result.input.slice(3))).toEqual(['h7', 'h8', 'h9']);
    expect(expectPairsWhole(result.input)).toBe(true);
  });

  it('includes the summary in the prefix digest', async () => {
    const capabilities = capabilitiesFor(200000);
    const tail = history.filter((entry) => entry.seq > 6);
    const withSummary = await buildContext(
      inputFor(capabilities, {
        sources: sourcesWith({ history, summary: { item: summaryItem, replacedThroughSeq: 6 } }),
      }),
      harness(capabilities).ports,
    );
    const withoutSummary = await buildContext(
      inputFor(capabilities, { sources: sourcesWith({ history: tail }) }),
      harness(capabilities).ports,
    );
    expect(withSummary.prefixDigest).not.toBe(withoutSummary.prefixDigest);
  });
});

describe('overflow handling', () => {
  it('throws at level 0 and shrinks recent turns to the current turn with a notice at level 1', async () => {
    const capabilities = capabilitiesFor(W);
    const { ports } = harness(capabilities);
    const text = (letter: string): string => letter.repeat(2400);
    const history = [
      user(1, 'q1'),
      call(2, 'c1'),
      output(3, 'c1', text('a')),
      call(4, 'c2'),
      output(5, 'c2', text('b')),
      user(6, 'q2'),
      call(7, 'c3'),
      output(8, 'c3', text('c')),
      call(9, 'c4'),
      output(10, 'c4', text('d')),
      user(11, 'q3'),
      call(12, 'c5'),
      output(13, 'c5', text('e')),
      call(14, 'c6'),
      output(15, 'c6', text('f')),
    ];
    expect(tokensOfItems(history.map((entry) => entry.item))).toBeGreaterThan(I);
    const overflow = await overflowOf(inputFor(capabilities, { sources: sourcesWith({ history }), level: 0 }), ports);
    expect(overflow.level).toBe(0);
    expect(overflow.lastLevel).toBe(false);
    expect(overflow.compaction).toBeUndefined();
    expect(overflow.compactionBlockedBy?.reason).toBe('no_step_boundary_outside_protection');
    const result = await buildContext(inputFor(capabilities, { sources: sourcesWith({ history }), level: 1 }), ports);
    expect(result.inputTokens).toBeLessThanOrEqual(I);
    expect(result.notices.some((notice) => notice.code === 'recent_turns_shrunk')).toBe(true);
    expect(result.evictions.map((eviction) => eviction.callId)).toEqual(['c1', 'c2', 'c3', 'c4']);
    expect(outputTextOf(result.input, 'c5')).toBe(text('e'));
    expect(outputTextOf(result.input, 'c6')).toBe(text('f'));
    expect(expectPairsWhole(result.input)).toBe(true);
  });

  it('emits no shrink notice when recent turns fit', async () => {
    const capabilities = capabilitiesFor(200000);
    const { ports } = harness(capabilities);
    const result = await buildContext(
      inputFor(capabilities, { sources: sourcesWith({ history: [user(1, 'q'), assistant(2, 'a')] }) }),
      ports,
    );
    expect(result.notices).toEqual([]);
  });

  it('throws ContextOverflowError when nothing evictable remains above I', async () => {
    const capabilities = capabilitiesFor(W);
    const { ports } = harness(capabilities);
    const history = [user(1, 'now'), assistant(2, 'z'.repeat(14000))];
    const error = await buildContext(inputFor(capabilities, { sources: sourcesWith({ history }) }), ports).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ContextOverflowError);
    const overflow = error as ContextOverflowError;
    expect(overflow.inputBudget).toBe(I);
    expect(overflow.ceiling).toBe(I);
    expect(overflow.inputTokens).toBeGreaterThan(I);
    expect(overflow.inputTokens).toBeGreaterThanOrEqual(3500);
  });
});

describe('the one eviction pass that the build runs and that sizing reads', () => {
  it('evicts every unprotected output at once under the cache prefix layout and to the low mark otherwise', () => {
    expect(evictionPassFor('cachePrefix', { floorTokens: 1000, highMark: 3000 })).toEqual({ kind: 'batch' });
    expect(evictionPassFor(undefined, { floorTokens: 1000, highMark: 3000 })).toEqual({ kind: 'toLowMark', lowMark: 2000 });
    expect(evictionPassFor(undefined, { floorTokens: 1001, highMark: 3000 })).toEqual({ kind: 'toLowMark', lowMark: 1001 + 999 });
  });

  it('plans a proactive compaction over the region the batch pass leaves, with the product layout', async () => {
    const capabilities = capabilitiesFor(W);
    const { ports } = harness(capabilities);
    const history = [
      user(1, 'q1'),
      call(2, 'c1'),
      output(3, 'c1', 'o'.repeat(3000)),
      assistant(4, 'x'.repeat(4400)),
      user(5, 'q2'),
      call(6, 'c2'),
      output(7, 'c2', 'p'.repeat(3000)),
      assistant(8, 'y'.repeat(4400)),
      user(9, 'now'),
    ];
    const result = await buildContext(inputFor(capabilities, { sources: sourcesWith({ history }), keepRecentTurns: 1, layout: 'cachePrefix' }), ports);
    expect(result.evictions.filter((eviction) => eviction.kind === 'omitted').map((eviction) => eviction.callId)).toEqual(['c1', 'c2']);
    expect(result.compaction).toBeDefined();
    const planned = JSON.stringify(result.compaction?.input);
    expect(planned).not.toContain('o'.repeat(3000));
    expect(planned).toContain('tool output omitted');
  });
});
