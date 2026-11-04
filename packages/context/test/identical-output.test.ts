import { describe, expect, it } from 'vitest';
import { buildContext } from '@momonga/context';
import type { HistoryItem } from '@momonga/context';
import type { FunctionCallOutputInputItem, InputItem } from '@momonga/protocol';
import {
  assistant,
  call,
  capabilitiesFor,
  handleOf,
  harness,
  inputFor,
  output,
  outputTextOf,
  sourcesWith,
  textOf,
  tokensOfItem,
  tokensOfItems,
  user,
} from './helpers.ts';

const WINDOW = 64000;
const SAME = 'src/a.ts:1: export const a = 1;\nsrc/b.ts:2: export const b = 2;';
const OTHER = 'src/c.ts:3: export const c = 3;';

const referenceTo = (callId: string, handle: string): string =>
  `[identical to the output of call ${callId}; stored as ${handle}; read it with ReadOutput]`;

const historyOf = (outputs: ReadonlyArray<readonly [string, string]>): HistoryItem[] => [
  user(1, 'question'),
  ...outputs.flatMap(([callId, text], index) => [call(2 * index + 2, callId), output(2 * index + 3, callId, text)]),
];

const build = async (history: HistoryItem[], overrides: Parameters<typeof inputFor>[1] = {}) => {
  const capabilities = capabilitiesFor(WINDOW);
  const { ports, blobs } = harness(capabilities);
  const result = await buildContext(
    inputFor(capabilities, { sources: sourcesWith({ history }), outputFormatters: ['identicalOutput'], ...overrides }),
    ports,
  );
  return { result, blobs };
};

describe('identicalOutput at build time', () => {
  it('renders a later byte-identical output as a reference to the earlier full output', async () => {
    const { result } = await build(historyOf([['c1', SAME], ['c2', SAME]]));
    expect(outputTextOf(result.input, 'c1')).toBe(SAME);
    expect(outputTextOf(result.input, 'c2')).toBe(referenceTo('c1', handleOf(SAME)));
    expect(result.inputTokens).toBe(tokensOfItems(result.input));
  });

  it('persists the content-addressed handle and reports the referrer as a reference', async () => {
    const { result, blobs } = await build(historyOf([['c1', SAME], ['c2', SAME]]));
    expect(blobs.puts.some((put) => put.text === SAME)).toBe(true);
    expect(result.evictions).toEqual([{ callId: 'c2', handle: handleOf(SAME), kind: 'reference' }]);
  });

  it('leaves every output full when identicalOutput is not enabled', async () => {
    const history = historyOf([['c1', SAME], ['c2', SAME]]);
    for (const outputFormatters of [undefined, [], ['log', 'json', 'grep']] as const) {
      const { result } = await build(history, { outputFormatters });
      expect(outputTextOf(result.input, 'c1')).toBe(SAME);
      expect(outputTextOf(result.input, 'c2')).toBe(SAME);
      expect(result.evictions).toEqual([]);
    }
  });

  it('does not treat outputs differing by one byte as identical', async () => {
    const { result } = await build(historyOf([['c1', SAME], ['c2', `${SAME}\n`], ['c3', OTHER]]));
    expect(outputTextOf(result.input, 'c2')).toBe(`${SAME}\n`);
    expect(outputTextOf(result.input, 'c3')).toBe(OTHER);
    expect(result.evictions).toEqual([]);
  });

  it('points every repeat at the earliest full output', async () => {
    const { result } = await build(historyOf([['c1', SAME], ['c2', OTHER], ['c3', SAME], ['c4', SAME]]));
    expect(outputTextOf(result.input, 'c1')).toBe(SAME);
    expect(outputTextOf(result.input, 'c2')).toBe(OTHER);
    expect(outputTextOf(result.input, 'c3')).toBe(referenceTo('c1', handleOf(SAME)));
    expect(outputTextOf(result.input, 'c4')).toBe(referenceTo('c1', handleOf(SAME)));
  });

  it('renders the referrer by the ordinary rules once its referent is omitted', async () => {
    const { result } = await build(historyOf([['c1', SAME], ['c2', SAME], ['c3', SAME]]), { evicted: new Set(['c1']) });
    expect(outputTextOf(result.input, 'c1')?.startsWith('[tool output omitted:')).toBe(true);
    expect(outputTextOf(result.input, 'c2')).toBe(SAME);
    expect(outputTextOf(result.input, 'c3')).toBe(referenceTo('c2', handleOf(SAME)));
  });

  it('does not refer to an output that was truncated rather than rendered in full', async () => {
    const big = 'line of build output\n'.repeat(400);
    const { result } = await build(historyOf([['c1', big], ['c2', big]]), { itemCap: 64 });
    const first = outputTextOf(result.input, 'c1') as string;
    const second = outputTextOf(result.input, 'c2') as string;
    expect(first).not.toBe(big);
    expect(second.startsWith('[identical to the output of call')).toBe(false);
    expect(second).toBe(first);
  });

  it('renders the same input after the reference is recorded on the referrer entry', async () => {
    const plain = historyOf([['c1', SAME], ['c2', SAME]]);
    const recorded = plain.map((entry) =>
      entry.item.type === 'function_call_output' && entry.item.call_id === 'c2' ? { ...entry, handle: handleOf(SAME) } : entry,
    );
    const before = await build(plain);
    const after = await build(recorded);
    expect(after.result.input).toEqual(before.result.input);
    expect(after.result.evictions).toEqual([]);
  });

  it('renders a recorded referrer by the ordinary rules once its referent is omitted', async () => {
    const recorded = historyOf([['c1', SAME], ['c2', SAME]]).map((entry) =>
      entry.item.type === 'function_call_output' && entry.item.call_id === 'c2' ? { ...entry, handle: handleOf(SAME) } : entry,
    );
    const { result } = await build(recorded, { evicted: new Set(['c1']) });
    expect(outputTextOf(result.input, 'c2')).toBe(SAME);
    expect(result.evictions.filter((eviction) => eviction.callId === 'c2')).toEqual([]);
  });

  it('renders an earlier output the same whether or not a later identical output follows', async () => {
    const alone = await build(historyOf([['c1', SAME]]));
    const followed = await build(historyOf([['c1', SAME], ['c2', SAME]]));
    expect(followed.result.input.slice(0, alone.result.input.length)).toEqual(alone.result.input);
  });
});

const PRESSURE_WINDOW = 4000;
const BIG = 'a'.repeat(2400);
const FILLER = (letter: string): string => letter.repeat(2400);

const pressuredHistory = (referrerProtected: boolean): HistoryItem[] => [
  user(1, 'old question'),
  call(2, 'c1'),
  output(3, 'c1', BIG),
  ...(referrerProtected ? [] : [call(4, 'c2'), output(5, 'c2', BIG)]),
  call(6, 'f1'),
  output(7, 'f1', FILLER('b')),
  call(8, 'f2'),
  output(9, 'f2', FILLER('c')),
  call(10, 'f3'),
  output(11, 'f3', FILLER('d')),
  assistant(12, 'old answer'),
  user(13, 'current question'),
  ...(referrerProtected ? [call(14, 'c2'), output(15, 'c2', BIG)] : [call(14, 'q1'), output(15, 'q1', 'ok')]),
];

const buildPressured = async (history: HistoryItem[], overrides: Parameters<typeof inputFor>[1] = {}) => {
  const capabilities = capabilitiesFor(PRESSURE_WINDOW);
  const { ports } = harness(capabilities);
  return buildContext(
    inputFor(capabilities, { sources: sourcesWith({ history }), keepRecentTurns: 1, outputFormatters: ['identicalOutput'], ...overrides }),
    ports,
  );
};

const outputItemOf = (items: readonly InputItem[], callId: string): FunctionCallOutputInputItem => {
  const found = items.find((item): item is FunctionCallOutputInputItem => item.type === 'function_call_output' && item.call_id === callId);
  if (found === undefined) throw new Error(`no output for ${callId}`);
  return found;
};

const omittedIds = (evictions: readonly { callId: string; kind: string }[]): string[] =>
  evictions.filter((eviction) => eviction.kind === 'omitted').map((eviction) => eviction.callId);

describe('identicalOutput under eviction pressure', () => {
  it('keeps a referent whose eviction would not lower the tokens of it and its referrers, and keeps the protected referrer a reference', async () => {
    const result = await buildPressured(pressuredHistory(true));
    expect(outputTextOf(result.input, 'c1')).toBe(BIG);
    expect(outputTextOf(result.input, 'c2')).toBe(referenceTo('c1', handleOf(BIG)));
    expect(omittedIds(result.evictions)).toEqual(['f1', 'f2', 'f3']);
    expect(result.inputTokens).toBe(tokensOfItems(result.input));
  });

  it('evicts a referent when its referrer re-rendered by the ordinary rules is smaller, and re-renders the referrer in the same build', async () => {
    const result = await buildPressured(pressuredHistory(true), { itemCap: 64, renderedFull: new Set(['c1', 'f1', 'f2', 'f3']) });
    expect(omittedIds(result.evictions)[0]).toBe('c1');
    expect(outputTextOf(result.input, 'c1')?.startsWith('[tool output omitted:')).toBe(true);
    const referrer = outputTextOf(result.input, 'c2') as string;
    expect(referrer.startsWith('[identical to the output of call')).toBe(false);
    expect(referrer).not.toBe(BIG);
    expect(referrer).toContain(`full output stored as ${handleOf(BIG)}`);
    expect(result.inputTokens).toBe(tokensOfItems(result.input));
  });

  it('evicts an unprotected referent exactly when the measured gain rule drops tokens, and never selects the reference rendering itself', async () => {
    const pair = pressuredHistory(false).filter((entry) => entry.seq <= 5);
    const unpressured = await buildPressured(pair, { evicted: new Set(['c1']) });
    const omittedItem = outputItemOf(unpressured.input, 'c1');
    const rerenderedItem = outputItemOf(unpressured.input, 'c2');
    const referentFull = tokensOfItem({ ...omittedItem, output: BIG });
    const referenceMarker = tokensOfItem({ ...rerenderedItem, output: referenceTo('c1', handleOf(BIG)) });
    const evictionDrops = tokensOfItem(omittedItem) + tokensOfItem(rerenderedItem) < referentFull + referenceMarker;
    expect(unpressured.evictions.filter((eviction) => eviction.callId === 'c2')).toEqual([]);

    const result = await buildPressured(pressuredHistory(false));
    const omitted = omittedIds(result.evictions);
    const ordinaryCandidates = evictionDrops ? ['c2', 'f1', 'f2', 'f3'] : ['f1', 'f2', 'f3'];
    if (evictionDrops) {
      expect(omitted[0]).toBe('c1');
      expect(outputTextOf(result.input, 'c1')).toBe(textOf(omittedItem.output));
      expect([textOf(rerenderedItem.output), outputTextOf(result.input, 'c1')]).toContain(outputTextOf(result.input, 'c2'));
    } else {
      expect(outputTextOf(result.input, 'c1')).toBe(BIG);
      expect(outputTextOf(result.input, 'c2')).toBe(referenceTo('c1', handleOf(BIG)));
    }
    const afterReferent = evictionDrops ? omitted.slice(1) : omitted;
    expect(afterReferent).toEqual(ordinaryCandidates.slice(0, afterReferent.length));
    expect(result.inputTokens).toBe(tokensOfItems(result.input));
  });
});
