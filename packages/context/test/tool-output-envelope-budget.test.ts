import { describe, expect, it } from 'vitest';
import { buildContext } from '@momonga/context';
import type { HistoryItem } from '@momonga/context';
import { TOOL_OUTPUT_TAG, fenceUntrusted } from '@momonga/protocol';
import type { InputItem } from '@momonga/protocol';
import { assistant, capabilitiesFor, handleOf, harness, inputFor, itemCapFor, omittedMarker, outputTextOf, sourcesWith, tokensOfItem, tokensOfItems, truncatedMarker, user, withTurnsBeforeCurrent } from './helpers.ts';
import { TEST_FENCE } from '@momonga/testkit';

const W = 4000;
const I = 2920;
const EXTERNAL = 'Read';
const HARNESS = 'Ack';

const callTo = (seq: number, callId: string, name: string): HistoryItem => ({
  seq,
  item: { type: 'function_call', id: `h${seq}`, call_id: callId, name, arguments: '{}' },
});

const outputOf = (seq: number, callId: string, text: string): HistoryItem => ({
  seq,
  item: { type: 'function_call_output', id: `h${seq}`, call_id: callId, output: text },
});

const build = async (history: HistoryItem[], extra: Parameters<typeof inputFor>[1] = {}) => {
  const capabilities = capabilitiesFor(W);
  const { ports, blobs } = harness(capabilities);
  const result = await buildContext(inputFor(capabilities, { sources: sourcesWith({ history }), harnessOutputTools: [HARNESS], ...extra }), ports);
  return { result, blobs };
};

describe('the envelope is part of the rendered size', () => {
  it('counts the enclosure of an external output in the input total, and not that of a harness output', async () => {
    const text = 'k'.repeat(1200);
    const external = await build([user(1, 'go'), callTo(2, 'c1', EXTERNAL), outputOf(3, 'c1', text)]);
    const raw = await build([user(1, 'go'), callTo(2, 'c1', HARNESS), outputOf(3, 'c1', text)]);
    const enclosed = fenceUntrusted(TOOL_OUTPUT_TAG, { call: 'c1', tool: EXTERNAL }, text, TEST_FENCE);
    expect(outputTextOf(external.result.input, 'c1')).toBe(enclosed);
    expect(outputTextOf(raw.result.input, 'c1')).toBe(text);
    expect(external.result.inputTokens).toBe(tokensOfItems(external.result.input));
    expect(external.result.inputTokens).toBeGreaterThan(raw.result.inputTokens);
  });

  it('truncates inside the enclosure, so the closing marker survives and the item stays within the item cap', async () => {
    const big = `HEAD${'m'.repeat(8000)}TAIL`;
    const { result, blobs } = await build([user(1, 'current'), callTo(2, 'big', EXTERNAL), outputOf(3, 'big', big)]);
    const text = outputTextOf(result.input, 'big') ?? '';
    expect(text.startsWith('<tool_output call="big" tool="Read" boundary="')).toBe(true);
    expect(text.split('\n').at(-1)).toMatch(/^<\/tool_output boundary="[0-9a-f]+">$/);
    expect(text).toContain('HEAD');
    expect(text).toContain('TAIL');
    expect(truncatedMarker.exec(text)?.[2]).toBe(handleOf(big));
    const item = result.input.find((entry) => entry.type === 'function_call_output') as InputItem;
    expect(tokensOfItem(item)).toBeLessThanOrEqual(itemCapFor(I));
    expect(blobs.puts).toEqual([{ text: big, mediaType: expect.any(String) }]);
  });

  it('stores the raw output under its handle and renders the omitted marker without an enclosure', async () => {
    const old = (letter: string): string => letter.repeat(2400);
    const history: HistoryItem[] = withTurnsBeforeCurrent([
      user(1, 'old question'),
      ...['a', 'b', 'c', 'd', 'e'].flatMap((letter, index): HistoryItem[] => [callTo(2 + 2 * index, `c${index}`, EXTERNAL), outputOf(3 + 2 * index, `c${index}`, old(letter))]),
      assistant(12, 'old answer'),
      user(13, 'current question'),
      callTo(14, 'now', EXTERNAL),
      outputOf(15, 'now', old('f')),
    ]);
    const { result, blobs } = await build(history);
    const marker = outputTextOf(result.input, 'c0') ?? '';
    const match = omittedMarker.exec(marker);
    expect(match).not.toBeNull();
    expect(match?.[2]).toBe(handleOf(old('a')));
    expect(Number(match?.[1])).toBeGreaterThanOrEqual(tokensOfItem({ type: 'function_call_output', call_id: 'c0', output: fenceUntrusted(TOOL_OUTPUT_TAG, { call: 'c0', tool: EXTERNAL }, old('a'), TEST_FENCE) }));
    expect(blobs.puts[0]?.text).toBe(old('a'));
    expect(result.inputTokens).toBe(tokensOfItems(result.input));
  });

  it('renders an output whose call is unknown to the history enclosed, failing closed', async () => {
    const { result } = await build([user(1, 'go'), outputOf(2, 'orphan', 'text')]);
    expect(outputTextOf(result.input, 'orphan') ?? '').toMatch(/^<tool_output call="orphan" tool="" boundary="/);
  });
});
