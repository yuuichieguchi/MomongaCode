import { describe, expect, it } from 'vitest';
import { buildContext } from '@momonga/context';
import type { HistoryItem } from '@momonga/context';
import {
  call,
  capabilitiesFor,
  handleOf,
  harness,
  inputFor,
  output,
  outputTextOf,
  sourcesWith,
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

  it('renders an earlier output the same whether or not a later identical output follows', async () => {
    const alone = await build(historyOf([['c1', SAME]]));
    const followed = await build(historyOf([['c1', SAME], ['c2', SAME]]));
    expect(followed.result.input.slice(0, alone.result.input.length)).toEqual(alone.result.input);
  });
});
