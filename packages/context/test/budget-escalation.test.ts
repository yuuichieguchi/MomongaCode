import { describe, expect, it } from 'vitest';
import { buildContext } from '@momonga/context';
import type { HistoryItem } from '@momonga/context';
import { argsCall, budgetFor, buildThroughLevels, capabilitiesFor, harness, inputFor, output, overflowOf, sourcesWith } from './helpers.ts';

const capabilities = capabilitiesFor(4000);
const OUTPUT_CHARS = 2000;
const PADDING_AT_BOUNDARY = 2752;

const fourSteps = (padding: number): HistoryItem[] =>
  [0, 1, 2, 3].flatMap((index) => [
    argsCall(2 * index + 1, `c${index}`, index === 3 ? 40 + padding : 40),
    output(2 * index + 2, `c${index}`, 'abcd'[index]?.repeat(OUTPUT_CHARS) ?? ''),
  ]);

const inputWith = (padding: number) => inputFor(capabilities, { sources: sourcesWith({ history: fourSteps(padding) }) });

describe('budget escalation of build-context', () => {
  it('sets the boundary at the input budget of the window', () => {
    expect(budgetFor(4000).I).toBe(2920);
  });

  it('keeps level 0 one token under the budget', async () => {
    const built = await buildContext(inputWith(PADDING_AT_BOUNDARY - 4), harness(capabilities).ports);
    expect(built.inputTokens).toBe(2919);
    expect(built.notices.map((notice) => notice.code)).toEqual([]);
  });

  it('keeps level 0 exactly at the budget, because the boundary is inclusive', async () => {
    const built = await buildContext(inputWith(PADDING_AT_BOUNDARY), harness(capabilities).ports);
    expect(built.inputTokens).toBe(2920);
    expect(built.notices.map((notice) => notice.code)).toEqual([]);
  });

  it('escalates one token over the budget and reports the reduction from 4 to 1', async () => {
    const input = inputWith(PADDING_AT_BOUNDARY + 4);
    const overflow = await overflowOf({ ...input, level: 0 }, harness(capabilities).ports);
    expect(overflow.inputTokens).toBe(2921);
    expect(overflow.lastLevel).toBe(false);

    const { built, level } = await buildThroughLevels(input, harness(capabilities).ports);
    expect(level).toBe(1);
    expect(built.notices.filter((notice) => notice.code === 'recent_steps_shrunk').map((notice) => notice.message)).toEqual([
      'recent steps of the current turn were reduced from 4 to 1 because the context budget was exceeded',
    ]);
  });
});
