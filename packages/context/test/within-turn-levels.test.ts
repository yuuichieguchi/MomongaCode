import { describe, expect, it } from 'vitest';
import { buildContext } from '@momonga/context';
import type { CompactionInputItem } from '@momonga/protocol';
import {
  argsCall,
  assistant,
  call,
  capabilitiesFor,
  expectPairsWhole,
  handleOf,
  harness,
  inputFor,
  omittedMarker,
  output,
  outputTextOf,
  overflowOf,
  sourcesWith,
  stepsOf,
  user,
} from './helpers.ts';
import type { HistoryItem } from '@momonga/context';

const LETTERS = 'abcdef';

const sixLargeOutputs = (): HistoryItem[] =>
  LETTERS.split('').flatMap((letter, index) => [call(2 * index + 1, `c${index}`), output(2 * index + 2, `c${index}`, letter.repeat(2400))]);

const evictedIds = (evictions: readonly { callId: string }[]): string[] => evictions.map((eviction) => eviction.callId);

describe('protection levels inside the current turn', () => {
  const capabilities = capabilitiesFor(4000);

  it('protects the last four steps at level 0 and evicts only older outputs of the same turn', async () => {
    const { ports, blobs } = harness(capabilities);
    const built = await buildContext(inputFor(capabilities, { sources: sourcesWith({ history: sixLargeOutputs() }), level: 0 }), ports);

    expect(built.evictions).toEqual([
      { callId: 'c0', handle: handleOf('a'.repeat(2400)), kind: 'omitted', tokens: expect.any(Number) },
      { callId: 'c1', handle: handleOf('b'.repeat(2400)), kind: 'omitted', tokens: expect.any(Number) },
    ]);
    expect(built.inputTokens).toBe(2695);
    expect(blobs.puts.map((put) => put.text)).toEqual(['a'.repeat(2400), 'b'.repeat(2400)]);
    for (const [index, letter] of [...LETTERS].entries()) {
      if (index < 2) expect(omittedMarker.exec(outputTextOf(built.input, `c${index}`) ?? '')).not.toBeNull();
      else expect(outputTextOf(built.input, `c${index}`)).toBe(letter.repeat(2400));
    }
    expect(built.input.filter((item) => item.type === 'function_call')).toHaveLength(6);
    expect(expectPairsWhole(built.input)).toBe(true);
    expect(built.compaction).toBeUndefined();
    expect(built.notices).toEqual([]);
  });

  it('protects only the last step at level 1 of a single-turn run and evicts down to the low-water mark', async () => {
    const { ports } = harness(capabilities);
    const built = await buildContext(inputFor(capabilities, { sources: sourcesWith({ history: sixLargeOutputs() }), level: 1 }), ports);

    expect(evictedIds(built.evictions)).toEqual(['c0', 'c1', 'c2', 'c3', 'c4']);
    expect(built.inputTokens).toBe(952);
    expect(outputTextOf(built.input, 'c5')).toBe('f'.repeat(2400));
    expect(built.notices.map((notice) => notice.code)).toContain('recent_steps_shrunk');
  });

  it('keeps an appended step from evicting again after an eviction batch, with an identical prefix', async () => {
    const first = await buildContext(inputFor(capabilities, { sources: sourcesWith({ history: sixLargeOutputs() }), level: 1 }), harness(capabilities).ports);
    const handles = new Map(first.evictions.map((eviction) => [eviction.callId, eviction.handle]));
    const journaled = sixLargeOutputs().map((entry) =>
      entry.item.type === 'function_call_output' && handles.has(entry.item.call_id) ? { ...entry, handle: handles.get(entry.item.call_id) as string } : entry,
    );
    const appended = [...journaled, call(13, 'c6'), output(14, 'c6', 'g'.repeat(2400))];

    const second = await buildContext(
      inputFor(capabilities, { sources: sourcesWith({ history: appended }), evicted: new Set(handles.keys()), level: 1 }),
      harness(capabilities).ports,
    );

    expect(second.evictions).toEqual([]);
    expect(outputTextOf(second.input, 'c5')).toBe('f'.repeat(2400));
    expect(second.input.slice(0, first.input.length)).toEqual(first.input);
    expect(second.prefixDigest).toBe(first.prefixDigest);
  });
});

describe('step labelling', () => {
  const small = capabilitiesFor(3000);

  it('treats a parallel batch as one step', async () => {
    const history = [
      call(1, 'c0'),
      output(2, 'c0', 'a'.repeat(2000)),
      call(3, 'c1'),
      call(4, 'c2'),
      output(5, 'c1', 'b'.repeat(2000)),
      output(6, 'c2', 'c'.repeat(2000)),
    ];
    const built = await buildContext(inputFor(small, { sources: sourcesWith({ history }), level: 1 }), harness(small).ports);

    expect(built.evictions).toEqual([{ callId: 'c0', handle: handleOf('a'.repeat(2000)), kind: 'omitted', tokens: expect.any(Number) }]);
    expect(outputTextOf(built.input, 'c1')).toBe('b'.repeat(2000));
    expect(outputTextOf(built.input, 'c2')).toBe('c'.repeat(2000));
  });

  it('makes a final assistant message after outputs a step of its own', async () => {
    const history = [call(1, 'c0'), output(2, 'c0', 'a'.repeat(2000)), argsCall(3, 'c1', 3900), output(4, 'c1', 'b'.repeat(2000)), assistant(5, 'done')];
    const built = await buildContext(inputFor(small, { sources: sourcesWith({ history }), level: 1 }), harness(small).ports);

    expect(evictedIds(built.evictions)).toEqual(['c0', 'c1']);
    expect(built.input.at(-1)).toMatchObject({ type: 'message', role: 'assistant', content: 'done' });
  });

  it('merges two model responses without an output between them into one step', async () => {
    const capabilities = capabilitiesFor(4000);
    const history = [argsCall(1, 'c0', 3900), output(2, 'c0', 'ok'), assistant(3, 'thinking'), argsCall(4, 'c1', 7390), output(5, 'c1', 'ok')];
    const error = await overflowOf(inputFor(capabilities, { sources: sourcesWith({ history }), level: 1 }), harness(capabilities).ports);

    expect(error.inputTokens).toBe(2953);
    expect(error.lastLevel).toBe(true);
    expect(error.compaction?.throughSeq).toBe(2);
  });

  it('reports a protected step whose call arguments alone exceed the room as its own blocked reason', async () => {
    const capabilities = capabilitiesFor(4000);
    const history = [argsCall(1, 'c0', 11800), output(2, 'c0', 'ok')];
    const error = await overflowOf(inputFor(capabilities, { sources: sourcesWith({ history }), level: 0 }), harness(capabilities).ports);

    expect(error.inputTokens).toBe(3023);
    expect(error.lastLevel).toBe(true);
    expect(error.compaction).toBeUndefined();
    expect(error.compactionBlockedBy?.reason).toBe('protected_step_exceeds_room');
  });

  it('restarts the step count at a user message and keeps the whole current turn at the last level', async () => {
    const capabilities = capabilitiesFor(8000);
    const history = [
      user(1, 'q0'),
      call(2, 't0'),
      output(3, 't0', 'p'.repeat(14000)),
      assistant(4, 'a0'),
      user(5, 'q1'),
      call(6, 'c0'),
      output(7, 'c0', 'q'.repeat(2400)),
    ];
    const built = await buildContext(inputFor(capabilities, { sources: sourcesWith({ history }), level: 1 }), harness(capabilities).ports);

    expect(evictedIds(built.evictions)).toEqual(['t0']);
    expect(outputTextOf(built.input, 'c0')).toBe('q'.repeat(2400));
  });
});

describe('protected zones with gaps', () => {
  it('evicts early current-turn outputs at level 0 while older recent turns stay intact, and never compacts across them', async () => {
    const capabilities = capabilitiesFor(8000);
    const history = [
      user(1, 'q0'),
      call(2, 't0'),
      output(3, 't0', 'p'.repeat(2400)),
      assistant(4, 'a0'),
      user(5, 'q1'),
      call(6, 't1'),
      output(7, 't1', 'q'.repeat(2400)),
      assistant(8, 'a1'),
      user(9, 'q2'),
      call(10, 'c0'),
      output(11, 'c0', 'a'.repeat(2400)),
      call(12, 'c1'),
      output(13, 'c1', 'b'.repeat(2400)),
      argsCall(14, 'c2', 2836),
      output(15, 'c2', 'ok'),
      argsCall(16, 'c3', 2836),
      output(17, 'c3', 'ok'),
      argsCall(18, 'c4', 2836),
      output(19, 'c4', 'ok'),
      argsCall(20, 'c5', 2836),
      output(21, 'c5', 'ok'),
    ];
    const built = await buildContext(inputFor(capabilities, { sources: sourcesWith({ history }), level: 0 }), harness(capabilities).ports);

    expect(evictedIds(built.evictions)).toEqual(['c0', 'c1']);
    expect(outputTextOf(built.input, 't0')).toBe('p'.repeat(2400));
    expect(outputTextOf(built.input, 't1')).toBe('q'.repeat(2400));
    expect(built.compaction).toBeUndefined();
  });
});

describe('levels are skipped when they protect the same slots', () => {
  const capabilities = capabilitiesFor(4000);

  it('has two levels for a single-turn run with several steps', async () => {
    const sources = sourcesWith({ history: stepsOf([930, 930, 2205, 2205, 2205, 2205]) });
    expect((await overflowOf(inputFor(capabilities, { sources, level: 0 }), harness(capabilities).ports)).lastLevel).toBe(false);
    expect((await overflowOf(inputFor(capabilities, { sources, level: 1 }), harness(capabilities).ports)).lastLevel).toBe(true);
  });

  it('skips the one-step level when the current turn has a single step', async () => {
    const history = [user(1, 'q0'), assistant(2, 'a'.repeat(4000)), user(3, 'q1'), argsCall(4, 'c1', 7800), output(5, 'c1', 'ok')];
    const sources = sourcesWith({ history });
    const atLevel0 = await overflowOf(inputFor(capabilities, { sources, level: 0 }), harness(capabilities).ports);
    const atLevel1 = await overflowOf(inputFor(capabilities, { sources, level: 1 }), harness(capabilities).ports);

    expect(atLevel0.lastLevel).toBe(false);
    expect(atLevel0.inputTokens).toBe(3068);
    expect(atLevel1.lastLevel).toBe(true);
    expect(atLevel1.compaction?.throughSeq).toBe(2);
  });
});

describe('ContextOverflowError facts', () => {
  const capabilities = capabilitiesFor(4000);

  it('carries the counts, the ceiling, the floor, the level and the forced compaction', async () => {
    const sources = sourcesWith({ history: stepsOf([930, 930, 2205, 2205, 2205, 2205]) });
    const error = await overflowOf(inputFor(capabilities, { sources, level: 0 }), harness(capabilities).ports);

    expect(error.inputTokens).toBe(2946);
    expect(error.inputBudget).toBe(2920);
    expect(error.ceiling).toBe(2920);
    expect(error.pinnedTokens).toBe(32);
    expect(error.floorTokens).toBe(32);
    expect(error.level).toBe(0);
    expect(error.lastLevel).toBe(false);
    expect(error.compaction?.throughSeq).toBe(4);
    expect(error.compaction?.summaryTokenCap).toBe(240);
    expect(error.compactionBlockedBy).toBeUndefined();
  });

  it('names no_step_boundary_outside_protection when a summary leaves nothing compactable', async () => {
    const summary = { item: { type: 'compaction', encrypted_content: 'e'.repeat(10350) } satisfies CompactionInputItem, replacedThroughSeq: 2 };
    const sources = sourcesWith({ history: [argsCall(3, 'c1', 1440), output(4, 'c1', 'ok')], summary });
    const error = await overflowOf(inputFor(capabilities, { sources, level: 0 }), harness(capabilities).ports);

    expect(error.inputTokens).toBe(3032);
    expect(error.lastLevel).toBe(true);
    expect(error.compaction).toBeUndefined();
    expect(error.compactionBlockedBy?.reason).toBe('no_step_boundary_outside_protection');
  });
});

describe('thresholds above the pinned floor', () => {
  it('neither evicts nor hints while the conversation stays below the high-water mark above a large floor', async () => {
    const capabilities = capabilitiesFor(4096, { maxOutputTokens: 1024 });
    const history = [user(1, 'q'), call(2, 'c1'), output(3, 'c1', 'o'.repeat(800)), user(4, 'now')];
    const built = await buildContext(
      inputFor(capabilities, { sources: sourcesWith({ systemPrompt: 's'.repeat(8700), history }) }),
      harness(capabilities).ports,
    );

    expect(built.inputTokens).toBe(2468);
    expect(built.evictions).toEqual([]);
    expect(built.compaction).toBeUndefined();
    expect(outputTextOf(built.input, 'c1')).toBe('o'.repeat(800));
  });
});
