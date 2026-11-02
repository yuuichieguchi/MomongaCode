import { describe, expect, it } from 'vitest';
import { ContextOverflowError, buildContext } from '@momonga/context';
import type { CompactionInputItem, InputItem, MessageInputItem } from '@momonga/protocol';
import {
  READ_TOOL,
  TASK,
  argsCall,
  assistant,
  call,
  capabilitiesFor,
  expectPairsWhole,
  handleOf,
  harness,
  idsOf,
  inputFor,
  omittedMarker,
  output,
  outputTextOf,
  overflowOf,
  sourcesWith,
  stepsOf,
  tokensOfItem,
  truncatedMarker,
  user,
} from './helpers.ts';
import type { HistoryItem } from '@momonga/context';

const capabilities = capabilitiesFor(4000);
const ITEM_CAP = 730;
const SUMMARY_CAP = 240;

const itemsOf = (history: readonly HistoryItem[], throughSeq: number): InputItem[] =>
  history.filter((entry) => entry.seq <= throughSeq).map((entry) => entry.item as InputItem);

const isTask = (item: InputItem): boolean => JSON.stringify(item) === JSON.stringify(TASK);

describe('proactive compaction inside one turn', () => {
  it('hints the latest step-end cut before the protected steps when the region passes the gain rule', async () => {
    const history = stepsOf([1400, 1400, 1400, 1400, 1400, 1400]);
    const built = await buildContext(inputFor(capabilities, { sources: sourcesWith({ history }), level: 0 }), harness(capabilities).ports);

    expect(built.inputTokens).toBe(2378);
    expect(built.compaction).toEqual({ throughSeq: 4, summaryTokenCap: SUMMARY_CAP, input: [TASK, ...itemsOf(history, 4)] });
  });

  it('gives no hint when the region is below twice the summary item', async () => {
    const history = stepsOf([930, 930, 2100, 2100, 2100, 2100]);
    const built = await buildContext(inputFor(capabilities, { sources: sourcesWith({ history }), level: 0 }), harness(capabilities).ports);

    expect(built.inputTokens).toBe(2842);
    expect(built.compaction).toBeUndefined();
  });

  it('never hints a proactive compaction at a level above 0', async () => {
    const history = stepsOf([1400, 1400, 1400, 1400, 1400, 1400]);
    const atLevel0 = await buildContext(inputFor(capabilities, { sources: sourcesWith({ history }), level: 0 }), harness(capabilities).ports);
    const atLevel1 = await buildContext(inputFor(capabilities, { sources: sourcesWith({ history }), level: 1 }), harness(capabilities).ports);

    expect(atLevel0.compaction?.throughSeq).toBe(4);
    expect(atLevel1.compaction).toBeUndefined();
  });
});

describe('forced compaction inside one turn', () => {
  it('accepts a cut whose region closes the deficit although it fails the proactive gain rule', async () => {
    const history = stepsOf([930, 930, 2205, 2205, 2205, 2205]);
    const error = await overflowOf(inputFor(capabilities, { sources: sourcesWith({ history }), level: 0 }), harness(capabilities).ports);

    expect(error.inputTokens).toBe(2946);
    expect(error.compaction).toEqual({ throughSeq: 4, summaryTokenCap: SUMMARY_CAP, input: [TASK, ...itemsOf(history, 4)] });
  });

  it('takes the latest cut before the last step at the last level', async () => {
    const history = stepsOf([930, 930, 2205, 2205, 2205, 2205]);
    const error = await overflowOf(inputFor(capabilities, { sources: sourcesWith({ history }), level: 1 }), harness(capabilities).ports);

    expect(error.lastLevel).toBe(true);
    expect(error.compaction?.throughSeq).toBe(10);
  });

  it('reports deficit_not_closed when the summary would not close the deficit', async () => {
    const history = stepsOf([930, 930, 2470, 2470, 2470, 2470]);
    const error = await overflowOf(inputFor(capabilities, { sources: sourcesWith({ history }), level: 0 }), harness(capabilities).ports);

    expect(error.inputTokens).toBe(3211);
    expect(error.compaction).toBeUndefined();
    expect(error.compactionBlockedBy?.reason).toBe('deficit_not_closed');
  });

  it('excludes the task from the region measured against the deficit', async () => {
    const history = [argsCall(1, 'c0', 1435), output(2, 'c0', 'ok'), argsCall(3, 'c1', 10063), output(4, 'c1', 'ok')];
    const error = await overflowOf(inputFor(capabilities, { sources: sourcesWith({ history }), level: 1 }), harness(capabilities).ports);

    expect(error.inputTokens).toBe(2989);
    expect(error.compaction).toBeUndefined();
    expect(error.compactionBlockedBy?.reason).toBe('deficit_not_closed');
  });

  it.for([
    { chars: 9879, inputTokens: 2944, fits: true },
    { chars: 9883, inputTokens: 2945, fits: false },
  ])('includes the task in the summary request budget (step of $chars characters)', async ({ chars, inputTokens, fits }) => {
    const history = [argsCall(1, 'c0', chars), output(2, 'c0', 'ok'), argsCall(3, 'c1', 1439), output(4, 'c1', 'ok')];
    const error = await overflowOf(inputFor(capabilities, { sources: sourcesWith({ history }), level: 1 }), harness(capabilities).ports);

    expect(error.inputTokens).toBe(inputTokens);
    if (fits) {
      expect(error.compaction?.throughSeq).toBe(2);
    } else {
      expect(error.compaction).toBeUndefined();
      expect(error.compactionBlockedBy?.reason).toBe('region_exceeds_summary_input_budget');
    }
  });
});

describe('compaction input is the rendered context', () => {
  it('holds the previous summary first, the task and the evicted 20k-character output as its marker', async () => {
    const summaryItem: CompactionInputItem = { type: 'compaction', encrypted_content: 's'.repeat(40) };
    const huge = 'r'.repeat(20000);
    const history = [
      call(1, 'c0'),
      output(2, 'c0', huge),
      argsCall(3, 'c1', 2800),
      output(4, 'c1', 'ok'),
      ...[2, 3, 4, 5].flatMap((index) => [argsCall(2 * index + 1, `c${index}`, 1440), output(2 * index + 2, `c${index}`, 'ok')]),
    ];
    const built = await buildContext(
      inputFor(capabilities, { sources: sourcesWith({ history, summary: { item: summaryItem, replacedThroughSeq: 0 } }), level: 0 }),
      harness(capabilities).ports,
    );

    const compaction = built.compaction;
    expect(compaction?.throughSeq).toBe(4);
    expect(compaction?.input[0]).toEqual(summaryItem);
    expect(compaction?.input[1]).toEqual(TASK);
    expect(idsOf(compaction?.input.slice(2) ?? [])).toEqual(['h1', 'h2', 'h3', 'h4']);
    const rendered = outputTextOf(compaction?.input ?? [], 'c0') ?? '';
    expect(omittedMarker.exec(rendered)?.[2]).toBe(handleOf(huge));
    expect(JSON.stringify(compaction?.input)).not.toContain('r'.repeat(1000));
    expect(compaction?.input.filter((item: InputItem) => item.type === 'message' && item.role === 'system')).toEqual([]);
  });

  it('leaves the task out when the cut lies before the task of an inherited history', async () => {
    const history = Array.from({ length: 3 }, (_unused, turn) => [
      user(2 * turn + 1, `q${turn} `.padEnd(1600, 'q')),
      assistant(2 * turn + 2, `a${turn} `.padEnd(1600, 'a')),
    ]).flat();
    const built = await buildContext(inputFor(capabilities, { sources: sourcesWith({ taskSeq: 7, history }) }), harness(capabilities).ports);

    expect(built.compaction?.throughSeq).toBe(2);
    expect(built.compaction?.input).toEqual(itemsOf(history, 2));
    expect(built.compaction?.input.some(isTask)).toBe(false);
  });

  it('renders an output above the item cap identically in two builds and never puts it in the compaction input above the cap', async () => {
    const history = [
      argsCall(1, 'c0', 1400),
      output(2, 'c0', 'ok'),
      argsCall(3, 'c1', 1400),
      output(4, 'c1', 'ok'),
      call(5, 'c2'),
      output(6, 'c2', 'r'.repeat(4000)),
      ...[3, 4, 5].flatMap((index) => [argsCall(2 * index + 1, `c${index}`, 600), output(2 * index + 2, `c${index}`, 'ok')]),
    ];
    const build = () => buildContext(inputFor(capabilities, { sources: sourcesWith({ history }), level: 0 }), harness(capabilities).ports);
    const first = await build();
    const second = await build();

    const renderedOf = (items: readonly InputItem[]) => items.find((item) => item.type === 'function_call_output' && item.call_id === 'c2');
    expect(renderedOf(second.input)).toEqual(renderedOf(first.input));
    expect(truncatedMarker.exec(outputTextOf(first.input, 'c2') ?? '')).not.toBeNull();
    expect(tokensOfItem(renderedOf(first.input) as InputItem)).toBeLessThanOrEqual(ITEM_CAP);
    expect(first.compaction?.throughSeq).toBe(4);
    for (const item of first.compaction?.input ?? []) {
      if (item.type === 'function_call_output') expect(tokensOfItem(item)).toBeLessThanOrEqual(ITEM_CAP);
    }
  });
});

describe('the build after a compaction', () => {
  it('fits at the level that compacted with a summary at the acceptance bound', async () => {
    const history = stepsOf([930, 930, 2205, 2205, 2205, 2205]);
    const error = await overflowOf(inputFor(capabilities, { sources: sourcesWith({ history }), level: 0 }), harness(capabilities).ports);
    const compaction = error.compaction;
    if (compaction === undefined) throw new Error('expected a forced compaction');
    const summaryItem: CompactionInputItem = { type: 'compaction', encrypted_content: 'e'.repeat(1281) };
    expect(tokensOfItem(summaryItem)).toBe(332);

    const built = await buildContext(
      inputFor(capabilities, {
        sources: sourcesWith({ history, summary: { item: summaryItem, replacedThroughSeq: compaction.throughSeq } }),
        level: 0,
      }),
      harness(capabilities).ports,
    );

    expect(built.inputTokens).toBe(2732);
    expect(built.input.slice(1, 3)).toEqual([summaryItem, TASK]);
    expect(built.input.filter(isTask)).toHaveLength(1);
    expect(expectPairsWhole(built.input)).toBe(true);
  });
});

describe('wrap-up build where the normal build overflows', () => {
  it('fits without the tool schemas although the normal build overflows at its last level', async () => {
    const bigTool = { ...READ_TOOL, name: 'Huge', description: 'd'.repeat(4000) };
    const instruction: MessageInputItem = {
      type: 'message',
      role: 'user',
      content: "The conversation no longer fits the model's context window. Summarize what you accomplished, what remains, and any state the user must know. Do not call tools.",
    };
    const sources = sourcesWith({ tools: [bigTool], history: [argsCall(1, 'c0', 7799), output(2, 'c0', 'ok')] });

    const normal = await buildContext(inputFor(capabilities, { sources, level: 0 }), harness(capabilities).ports).catch((caught: unknown) => caught);
    expect(normal).toBeInstanceOf(ContextOverflowError);
    expect((normal as ContextOverflowError).inputTokens).toBe(3048);
    expect((normal as ContextOverflowError).lastLevel).toBe(true);

    const wrapUp = await buildContext(inputFor(capabilities, { sources, level: 0, tools: 'none', trailing: [instruction] }), harness(capabilities).ports);
    expect(wrapUp.tools).toEqual([]);
    expect(wrapUp.inputTokens).toBe(2074);
    expect(wrapUp.input.at(-1)).toEqual(instruction);
  });
});
