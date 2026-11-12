import { describe, expect, it } from 'vitest';
import { buildContext } from '@momonga/context';
import type { InputItem } from '@momonga/protocol';
import {
  assistant,
  call,
  capabilitiesFor,
  expectPairsWhole,
  handleOf,
  harness,
  inputFor,
  itemCapFor,
  omittedMarker,
  output,
  outputTextOf,
  sourcesWith,
  tokensOfItem,
  tokensOfItems,
  tokensOfText,
  truncatedMarker,
  user,
  withTurnsBeforeCurrent,
} from './helpers.ts';
import type { DeepReadonly, HistoryItem } from '@momonga/context';

const OLD_TEXT = (letter: string): string => letter.repeat(2400);
const CURRENT_TEXT = 'f'.repeat(2000);

const evictionHistory = (): HistoryItem[] => withTurnsBeforeCurrent([
  user(1, 'old question'),
  call(2, 'c1'),
  output(3, 'c1', OLD_TEXT('a')),
  call(4, 'c2'),
  output(5, 'c2', OLD_TEXT('b'), 'pre-c2'),
  call(6, 'c3'),
  output(7, 'c3', OLD_TEXT('c')),
  call(8, 'c4'),
  output(9, 'c4', OLD_TEXT('d')),
  call(10, 'c5'),
  output(11, 'c5', OLD_TEXT('e')),
  assistant(12, 'old answer'),
  user(13, 'current question'),
  call(14, 'c6'),
  output(15, 'c6', CURRENT_TEXT),
]);

const W = 4000;
const I = 2920;
const FLOOR = 32;
const HIGH_MARK = FLOOR + 0.7 * (I - FLOOR);
const LOW_MARK = FLOOR + 0.5 * (HIGH_MARK - FLOOR);

const originalOutput = (history: HistoryItem[], callId: string): DeepReadonly<InputItem> => {
  const found = history.find((entry) => entry.item.type === 'function_call_output' && entry.item.call_id === callId);
  if (found === undefined) throw new Error(`missing ${callId}`);
  return found.item;
};

describe('eviction of stale tool outputs', () => {
  it('evicts the oldest evictable outputs first, down to the low-water mark above the floor', async () => {
    const capabilities = capabilitiesFor(W);
    const { ports, blobs } = harness(capabilities);
    const history = evictionHistory();
    const result = await buildContext(
      inputFor(capabilities, { sources: sourcesWith({ history }) }),
      ports,
    );
    expect(result.budget.I).toBe(I);
    const evictedIds = result.evictions.map((eviction) => eviction.callId);
    expect(evictedIds).toEqual(['c1', 'c2', 'c3', 'c4', 'c5']);
    expect(result.evictions.every((eviction) => eviction.kind === 'omitted')).toBe(true);
    expect(result.inputTokens).toBe(tokensOfItems(result.input));
    expect(result.inputTokens).toBeLessThanOrEqual(LOW_MARK);

    const lastEvicted = evictedIds.at(-1) as string;
    const restored = result.input.map((item) =>
      item.type === 'function_call_output' && item.call_id === lastEvicted ? originalOutput(history, lastEvicted) : item,
    );
    expect(tokensOfItems(restored)).toBeGreaterThan(LOW_MARK);

    expect(outputTextOf(result.input, 'c6')).toBe(CURRENT_TEXT);
    expect(result.evictions.some((eviction) => eviction.callId === 'c6')).toBe(false);
    expect(blobs.puts.length).toBe(evictedIds.filter((id) => id !== 'c2').length);
  });

  it('renders the exact omitted marker naming the handle', async () => {
    const capabilities = capabilitiesFor(W);
    const { ports, blobs } = harness(capabilities);
    const history = evictionHistory();
    const result = await buildContext(
      inputFor(capabilities, { sources: sourcesWith({ history }) }),
      ports,
    );
    const marker = outputTextOf(result.input, 'c1') ?? '';
    const match = omittedMarker.exec(marker);
    expect(match).not.toBeNull();
    const tokens = Number(match?.[1]);
    expect(tokens).toBeGreaterThanOrEqual(tokensOfText(OLD_TEXT('a')));
    expect(tokens).toBeLessThanOrEqual(tokensOfItem(originalOutput(history, 'c1')));
    expect(match?.[2]).toBe(handleOf(OLD_TEXT('a')));
    expect(blobs.puts[0]?.text).toBe(OLD_TEXT('a'));
    expect(typeof blobs.puts[0]?.mediaType).toBe('string');
    expect(result.evictions[0]).toEqual({ callId: 'c1', handle: handleOf(OLD_TEXT('a')), kind: 'omitted', tokens: expect.any(Number) });
  });

  it('reuses an existing handle instead of putting the output again', async () => {
    const capabilities = capabilitiesFor(W);
    const { ports, blobs } = harness(capabilities);
    const result = await buildContext(
      inputFor(capabilities, { sources: sourcesWith({ history: evictionHistory() }) }),
      ports,
    );
    expect(result.evictions[1]).toEqual({ callId: 'c2', handle: 'pre-c2', kind: 'omitted', tokens: expect.any(Number) });
    expect(omittedMarker.exec(outputTextOf(result.input, 'c2') ?? '')?.[2]).toBe('pre-c2');
    expect(blobs.puts.some((put) => put.text === OLD_TEXT('b'))).toBe(false);
  });

  it('keeps every function_call and never breaks call/output pairs', async () => {
    const capabilities = capabilitiesFor(W);
    const { ports } = harness(capabilities);
    const result = await buildContext(
      inputFor(capabilities, { sources: sourcesWith({ history: evictionHistory() }) }),
      ports,
    );
    const callIds = result.input.flatMap((item) => (item.type === 'function_call' ? [item.call_id] : []));
    expect(callIds).toEqual(['c1', 'c2', 'c3', 'c4', 'c5', 'c6']);
    expect(expectPairsWhole(result.input)).toBe(true);
  });

  it('produces identical markers for identical inputs', async () => {
    const capabilities = capabilitiesFor(W);
    const build = async () =>
      buildContext(
        inputFor(capabilities, { sources: sourcesWith({ history: evictionHistory() }) }),
        harness(capabilities).ports,
      );
    const first = await build();
    const second = await build();
    expect(second.input).toEqual(first.input);
    expect(second.prefixDigest).toBe(first.prefixDigest);
  });

  it('keeps previously evicted outputs evicted via the evicted set', async () => {
    const capabilities = capabilitiesFor(200000);
    const { ports, blobs } = harness(capabilities);
    const history = evictionHistory().map((entry) =>
      entry.item.type === 'function_call_output' && entry.item.call_id === 'c1' ? { ...entry, handle: 'blob-1' } : entry,
    );
    const result = await buildContext(
      inputFor(capabilities, { sources: sourcesWith({ history }), evicted: new Set(['c1']) }),
      ports,
    );
    const match = omittedMarker.exec(outputTextOf(result.input, 'c1') ?? '');
    expect(match?.[2]).toBe('blob-1');
    expect(outputTextOf(result.input, 'c2')).toBe(OLD_TEXT('b'));
    expect(blobs.puts).toEqual([]);
    expect(expectPairsWhole(result.input)).toBe(true);
  });

  it('does not evict anything when the input is below the high-water mark', async () => {
    const capabilities = capabilitiesFor(200000);
    const { ports, blobs } = harness(capabilities);
    const result = await buildContext(
      inputFor(capabilities, { sources: sourcesWith({ history: evictionHistory() }) }),
      ports,
    );
    expect(result.evictions).toEqual([]);
    expect(blobs.puts).toEqual([]);
    expect(outputTextOf(result.input, 'c1')).toBe(OLD_TEXT('a'));
  });
});

describe('per-item cap', () => {
  const bigText = `HEAD${'m'.repeat(8000)}TAIL`;

  it('truncates an oversized current-step output to head, marker and tail within itemCap', async () => {
    const capabilities = capabilitiesFor(W);
    const { ports, blobs } = harness(capabilities);
    const history = [user(1, 'current'), call(2, 'big'), output(3, 'big', bigText)];
    const result = await buildContext(inputFor(capabilities, { sources: sourcesWith({ history }) }), ports);
    const text = outputTextOf(result.input, 'big') ?? '';
    expect(text.startsWith('HEAD')).toBe(true);
    expect(text.endsWith('TAIL')).toBe(true);
    const match = truncatedMarker.exec(text);
    expect(match).not.toBeNull();
    expect(match?.[2]).toBe(handleOf(bigText));
    expect(Number(match?.[1])).toBeGreaterThan(0);
    const truncatedItem = result.input.find((item) => item.type === 'function_call_output');
    expect(tokensOfItem(truncatedItem as InputItem)).toBeLessThanOrEqual(itemCapFor(I));
    expect(blobs.puts).toEqual([{ text: bigText, mediaType: expect.any(String) }]);
    expect(result.evictions).toEqual([{ callId: 'big', handle: handleOf(bigText), kind: 'truncated' }]);
    expect(result.inputTokens).toBeLessThanOrEqual(I);
  });

  it('uses the existing handle for a truncated output without a put', async () => {
    const capabilities = capabilitiesFor(W);
    const { ports, blobs } = harness(capabilities);
    const history = [user(1, 'current'), call(2, 'big'), output(3, 'big', bigText, 'pre-big')];
    const result = await buildContext(inputFor(capabilities, { sources: sourcesWith({ history }) }), ports);
    expect(truncatedMarker.exec(outputTextOf(result.input, 'big') ?? '')?.[2]).toBe('pre-big');
    expect(blobs.puts).toEqual([]);
    expect(result.evictions).toEqual([{ callId: 'big', handle: 'pre-big', kind: 'truncated' }]);
  });

  it('truncates deterministically', async () => {
    const capabilities = capabilitiesFor(W);
    const history = [user(1, 'current'), call(2, 'big'), output(3, 'big', bigText)];
    const first = await buildContext(inputFor(capabilities, { sources: sourcesWith({ history }) }), harness(capabilities).ports);
    const second = await buildContext(inputFor(capabilities, { sources: sourcesWith({ history }) }), harness(capabilities).ports);
    expect(second.input).toEqual(first.input);
  });

  it('leaves outputs at or below itemCap untouched', async () => {
    const capabilities = capabilitiesFor(W);
    const { ports, blobs } = harness(capabilities);
    const text = 'k'.repeat(2000);
    const history = [user(1, 'current'), call(2, 'small'), output(3, 'small', text)];
    const result = await buildContext(inputFor(capabilities, { sources: sourcesWith({ history }) }), ports);
    expect(outputTextOf(result.input, 'small')).toBe(text);
    expect(blobs.puts).toEqual([]);
  });
});
