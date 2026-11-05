import { describe, expect, it } from 'vitest';
import { buildContext } from '@momonga/context';
import type { BuildContextInput, ContextEviction, HistoryItem } from '@momonga/context';
import { call, capabilitiesFor, handleOf, harness, inputFor, output, outputTextOf, sourcesWith, user } from './helpers.ts';

const WINDOW = 64000;
const SAME = 'src/a.ts:1: export const a = 1;\nsrc/b.ts:2: export const b = 2;';
const RAW_HANDLE = 'a'.repeat(64);

const referenceTo = (callId: string, handle: string): string =>
  `[identical to the output of call ${callId}; stored as ${handle}; read it with ReadOutput]`;

type WithRecordedReferences = BuildContextInput & { recordedReferences?: ReadonlySet<string> };

const historyWith = (secondHandle: string | undefined): HistoryItem[] => [
  user(1, 'question'),
  call(2, 'c1'),
  output(3, 'c1', SAME, RAW_HANDLE),
  call(4, 'c2'),
  output(5, 'c2', SAME, secondHandle),
];

const build = async (history: HistoryItem[], recordedReferences: ReadonlySet<string>) => {
  const capabilities = capabilitiesFor(WINDOW);
  const { ports } = harness(capabilities);
  const input: WithRecordedReferences = {
    ...inputFor(capabilities, { sources: sourcesWith({ history }), outputFormatters: ['identicalOutput'] }),
    recordedReferences,
  };
  return buildContext(input, ports);
};

const referencesOf = (evictions: readonly ContextEviction[]): ContextEviction[] => evictions.filter((eviction) => eviction.kind === 'reference');

describe('whether a reference is already recorded is decided by the build alone, from the recorded set (item 17(a))', () => {
  it('reports the reference of an output that carries its raw handle when the recorded set does not hold it', async () => {
    const built = await build(historyWith(RAW_HANDLE), new Set());

    expect(outputTextOf(built.input, 'c2')).toBe(referenceTo('c1', handleOf(SAME)));
    expect(referencesOf(built.evictions)).toEqual([{ callId: 'c2', handle: handleOf(SAME), kind: 'reference' }]);
  });

  it('reports nothing new for an output with a raw handle once the recorded set holds its reference, and renders it the same', async () => {
    const first = await build(historyWith(RAW_HANDLE), new Set());
    const recorded = new Set(referencesOf(first.evictions).map((eviction) => eviction.callId));

    const second = await build(historyWith(RAW_HANDLE), recorded);

    expect(referencesOf(second.evictions)).toEqual([]);
    expect(outputTextOf(second.input, 'c2')).toBe(outputTextOf(first.input, 'c2'));
  });

  it('reports the reference when the entry handle equals the content address but the recorded set does not hold it', async () => {
    const built = await build(historyWith(handleOf(SAME)), new Set());

    expect(referencesOf(built.evictions)).toEqual([{ callId: 'c2', handle: handleOf(SAME), kind: 'reference' }]);
  });

  it('reports a referrer exactly once across a sequence of builds that feed each build the references recorded so far', async () => {
    const recorded = new Set<string>();
    const reported: string[] = [];
    for (let round = 0; round < 3; round += 1) {
      const built = await build(historyWith(RAW_HANDLE), recorded);
      for (const eviction of referencesOf(built.evictions)) {
        reported.push(eviction.callId);
        recorded.add(eviction.callId);
      }
    }

    expect(reported).toEqual(['c2']);
  });
});
