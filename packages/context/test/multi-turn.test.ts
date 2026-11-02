import { describe, expect, it } from 'vitest';
import { ContextOverflowError, PinnedOverflowError, buildContext } from '@momonga/context';
import type { HistoryItem } from '@momonga/context';
import type { CompactionInputItem, InputItem, MessageInputItem } from '@momonga/protocol';
import {
  ROOT_AGENTS,
  TASK,
  assistant,
  call,
  capabilitiesFor,
  harness,
  idsOf,
  inputFor,
  output,
  overflowOf,
  sourcesWith,
  touchedFile,
  user,
} from './helpers.ts';

const summaryItem: CompactionInputItem = { type: 'compaction', encrypted_content: 'enc-summary' };
const isTask = (item: InputItem): boolean => JSON.stringify(item) === JSON.stringify(TASK);
const taskCount = (items: readonly InputItem[]): number => items.filter(isTask).length;

const inheritedTurns = (count: number, textLength: number): HistoryItem[] =>
  Array.from({ length: count }, (_unused, turn) => [user(2 * turn + 1, `q${turn} `.padEnd(textLength, 'q')), assistant(2 * turn + 2, `a${turn} `.padEnd(textLength, 'a'))]).flat();

describe('chronological task placement', () => {
  it('emits the task after the inherited history and before the run’s own items', async () => {
    const capabilities = capabilitiesFor(200000);
    const result = await buildContext(
      inputFor(capabilities, {
        sources: sourcesWith({ taskSeq: 3, history: [user(1, 'q1'), assistant(2, 'a1'), call(4, 'c1'), output(5, 'c1', 'r1')] }),
      }),
      harness(capabilities).ports,
    );
    expect(result.input[0]).toMatchObject({ type: 'message', role: 'system' });
    expect(idsOf(result.input.slice(1, 3))).toEqual(['h1', 'h2']);
    expect(result.input[3]).toEqual(TASK);
    expect(idsOf(result.input.slice(4))).toEqual(['h4', 'h5']);
    expect(taskCount(result.input)).toBe(1);
  });

  it('emits the task last on the first step of a run that inherited a conversation', async () => {
    const capabilities = capabilitiesFor(200000);
    const result = await buildContext(
      inputFor(capabilities, { sources: sourcesWith({ taskSeq: 3, history: [user(1, 'q1'), assistant(2, 'a1')] }) }),
      harness(capabilities).ports,
    );
    expect(result.input.at(-1)).toEqual(TASK);
    expect(idsOf(result.input.slice(1, 3))).toEqual(['h1', 'h2']);
  });

  it('orders layers, nested instructions, skills, summary, inherited history, task and own items', async () => {
    const capabilities = capabilitiesFor(200000);
    const result = await buildContext(
      inputFor(capabilities, {
        touchedPaths: [touchedFile('/proj/src/a.ts')],
        sources: sourcesWith({
          taskSeq: 5,
          activatedSkills: [{ name: 'skill', content: 'skill body' }],
          summary: { item: summaryItem, replacedThroughSeq: 2 },
          history: [user(3, 'q2'), assistant(4, 'a2'), assistant(6, 'own')],
        }),
      }),
      harness(capabilities, { files: { [ROOT_AGENTS]: 'root rules', '/proj/src/AGENTS.md': 'src rules' } }).ports,
    );
    const roles = result.input.map((item) => (item.type === 'message' ? item.role : item.type));
    expect(roles).toEqual(['system', 'developer', 'developer', 'developer', 'compaction', 'user', 'assistant', 'user', 'assistant']);
    expect(result.input[4]).toEqual(summaryItem);
    expect(idsOf(result.input.slice(5, 7))).toEqual(['h3', 'h4']);
    expect(result.input[7]).toEqual(TASK);
    expect(idsOf(result.input.slice(8))).toEqual(['h6']);
  });

  it('emits [layers, summary, task] with an empty inherited history and a summary', async () => {
    const capabilities = capabilitiesFor(200000);
    const result = await buildContext(
      inputFor(capabilities, { sources: sourcesWith({ taskSeq: 3, history: [], summary: { item: summaryItem, replacedThroughSeq: 2 } }) }),
      harness(capabilities).ports,
    );
    expect(result.input).toHaveLength(3);
    expect(result.input[1]).toEqual(summaryItem);
    expect(result.input[2]).toEqual(TASK);
  });

  it('emits the task directly after a summary that covers it, exactly once, before the retained entries', async () => {
    const capabilities = capabilitiesFor(200000);
    const result = await buildContext(
      inputFor(capabilities, {
        sources: sourcesWith({
          taskSeq: 3,
          summary: { item: summaryItem, replacedThroughSeq: 5 },
          history: [user(1, 'q1'), assistant(2, 'a1'), call(4, 'c1'), output(5, 'c1', 'r1'), assistant(6, 'a2'), call(7, 'c2'), output(8, 'c2', 'r2')],
        }),
      }),
      harness(capabilities).ports,
    );
    expect(result.input[1]).toEqual(summaryItem);
    expect(result.input[2]).toEqual(TASK);
    expect(idsOf(result.input.slice(3))).toEqual(['h6', 'h7', 'h8']);
    expect(taskCount(result.input)).toBe(1);
  });

  it('keeps the input of the previous run as a prefix when layers and summary are unchanged', async () => {
    const capabilities = capabilitiesFor(200000);
    const firstTask: MessageInputItem = { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'First task.' }] };
    const previous = await buildContext(
      inputFor(capabilities, { sources: sourcesWith({ task: firstTask, taskSeq: 1, history: [call(2, 'c1'), output(3, 'c1', 'r1'), assistant(4, 'done')] }) }),
      harness(capabilities).ports,
    );
    const next = await buildContext(
      inputFor(capabilities, {
        sources: sourcesWith({
          taskSeq: 5,
          history: [{ seq: 1, item: firstTask }, call(2, 'c1'), output(3, 'c1', 'r1'), assistant(4, 'done')],
        }),
      }),
      harness(capabilities).ports,
    );
    expect(next.input.slice(0, previous.input.length)).toEqual(previous.input);
    expect(next.input.at(-1)).toEqual(TASK);
  });
});

describe('digests with a multi-turn history', () => {
  it('keeps pinnedDigest independent of the inherited history and equal to the single-run value', async () => {
    const capabilities = capabilitiesFor(200000);
    const files = { [ROOT_AGENTS]: 'root rules' };
    const single = await buildContext(inputFor(capabilities, { sources: sourcesWith() }), harness(capabilities, { files }).ports);
    const inherited = await buildContext(
      inputFor(capabilities, { sources: sourcesWith({ taskSeq: 3, history: [user(1, 'q1'), assistant(2, 'a1')] }) }),
      harness(capabilities, { files }).ports,
    );
    expect(inherited.pinnedDigest).toBe(single.pinnedDigest);
    expect(inherited.input).not.toEqual(single.input);
  });

  it('leaves the task out of prefixDigest while pinnedDigest still covers it', async () => {
    const capabilities = capabilitiesFor(200000);
    const sources = { taskSeq: 3, history: [user(1, 'q1'), assistant(2, 'a1')] };
    const first = await buildContext(inputFor(capabilities, { sources: sourcesWith(sources) }), harness(capabilities).ports);
    const second = await buildContext(
      inputFor(capabilities, { sources: sourcesWith({ ...sources, task: { ...TASK, content: 'Another task.' } }) }),
      harness(capabilities).ports,
    );
    expect(second.prefixDigest).toBe(first.prefixDigest);
    expect(second.pinnedDigest).not.toBe(first.pinnedDigest);
  });
});

describe('the floor with an inherited history', () => {
  it('still counts the task in the floor: a huge task throws PinnedOverflowError', async () => {
    const capabilities = capabilitiesFor(4000);
    const error = await buildContext(
      inputFor(capabilities, { sources: sourcesWith({ taskSeq: 3, task: { ...TASK, content: 'x'.repeat(20_000) }, history: [user(1, 'q1'), assistant(2, 'a1')] }) }),
      harness(capabilities).ports,
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PinnedOverflowError);
  });

  it('never throws PinnedOverflowError for a huge inherited history', async () => {
    const capabilities = capabilitiesFor(4000);
    const error = await buildContext(
      inputFor(capabilities, { sources: sourcesWith({ taskSeq: 7, history: inheritedTurns(3, 8000) }) }),
      harness(capabilities).ports,
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ContextOverflowError);
    expect(error).not.toBeInstanceOf(PinnedOverflowError);
  });
});

describe('the task as a turn boundary', () => {
  it('makes a single inherited turn a compaction candidate at level 1, blocked only by the summary input budget', async () => {
    const capabilities = capabilitiesFor(4000);
    const sources = sourcesWith({ taskSeq: 3, history: inheritedTurns(1, 8000) });
    const atLevel0 = await overflowOf(inputFor(capabilities, { sources, level: 0 }), harness(capabilities).ports);
    expect(atLevel0.lastLevel).toBe(false);
    expect(atLevel0.compactionBlockedBy?.reason).toBe('no_step_boundary_outside_protection');
    const atLevel1 = await overflowOf(inputFor(capabilities, { sources, level: 1 }), harness(capabilities).ports);
    expect(atLevel1.lastLevel).toBe(true);
    expect(atLevel1.compaction).toBeUndefined();
    expect(atLevel1.compactionBlockedBy?.reason).toBe('region_exceeds_summary_input_budget');
  });

  it('with three inherited turns and keep 3 makes only the oldest compactable on the first step', async () => {
    const capabilities = capabilitiesFor(4000);
    const result = await buildContext(
      inputFor(capabilities, { sources: sourcesWith({ taskSeq: 7, history: inheritedTurns(3, 1600) }) }),
      harness(capabilities).ports,
    );
    expect(result.compaction?.throughSeq).toBe(2);
    expect(result.notices.map((notice) => notice.code)).toEqual([]);
  });

  it('compacts the oldest inherited turn at level 0 before shrinking, and later turns only after the shrink', async () => {
    const capabilities = capabilitiesFor(4000);
    const sources = sourcesWith({ taskSeq: 7, history: inheritedTurns(3, 2000) });
    const atLevel0 = await overflowOf(inputFor(capabilities, { sources, level: 0 }), harness(capabilities).ports);
    expect(atLevel0.inputTokens).toBe(3119);
    expect(atLevel0.compaction?.throughSeq).toBe(2);
    const atLevel1 = await overflowOf(inputFor(capabilities, { sources, level: 1 }), harness(capabilities).ports);
    expect(atLevel1.compaction?.throughSeq).toBe(4);
  });

  it('starts a new turn for own items after the task, so inherited outputs are evicted oldest first and own outputs never', async () => {
    const capabilities = capabilitiesFor(3000);
    const big = (label: string): string => `${label} `.padEnd(2000, 'o');
    const result = await buildContext(
      inputFor(capabilities, {
        sources: sourcesWith({
          taskSeq: 9,
          history: [
            user(1, 'q1'),
            call(2, 'c1'),
            output(3, 'c1', big('c1')),
            assistant(4, 'a1'),
            user(5, 'q2'),
            call(6, 'c2'),
            output(7, 'c2', big('c2')),
            assistant(8, 'a2'),
            call(10, 'c3'),
            output(11, 'c3', big('c3')),
            call(12, 'c4'),
            output(13, 'c4', big('c4')),
          ],
        }),
        level: 1,
      }),
      harness(capabilities).ports,
    );
    expect(result.evictions.map((eviction) => eviction.callId)).toEqual(['c1', 'c2']);
    expect(result.evictions.every((eviction) => eviction.kind === 'omitted')).toBe(true);
    expect(result.input.at(-1)).toMatchObject({ type: 'function_call_output', call_id: 'c4', output: big('c4') });
  });
});
