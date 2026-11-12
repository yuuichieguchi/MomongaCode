import { describe, expect, it } from 'vitest';
import { referenceKindsOf, renderWorkingState } from '@momonga/context';
import type { RunState } from '@momonga/protocol';
import { initialRunState } from '@momonga/store';
import { TEST_FENCE } from '@momonga/testkit';

const tokensOf = (text: string): number => Math.ceil(text.length / 4);

const base = (): RunState => initialRunState({ runId: 'run-refs', sessionId: 'session-refs', fence: TEST_FENCE });

const compacted = (): RunState => {
  const state = base();
  return {
    ...state,
    summary: { item: { type: 'message', role: 'user', content: 'summary' }, summary: 'summary', replacedThroughSeq: 4 },
    workingFacts: { ...state.workingFacts, replacedThroughEventSeq: 12 },
  };
};

const withHandle = (state: RunState): RunState => ({
  ...state,
  history: [{ seq: 1, item: { type: 'function_call_output', call_id: 'c1', output: 'omitted' }, callId: 'c1', handle: 'a'.repeat(64) }],
});

const kinds = (state: RunState): string[] => [...referenceKindsOf(state)].sort();

const render = (state: RunState, readers: Readonly<Record<string, string>>): string => {
  const text = renderWorkingState(state, { capTokens: 4096, tokensOf, verificationCommands: [], readers });
  if (text === undefined) throw new Error('no working state rendered');
  return text;
};

const UNREADABLE = 'replaced: seq 1-12 (recorded; no tool in this run reads it)';

describe('referenceKindsOf', () => {
  it('holds nothing before a compaction and with no handle', () => {
    expect(kinds(base())).toEqual([]);
  });

  it('holds history_range once a range was replaced', () => {
    expect(kinds(compacted())).toEqual(['history_range']);
  });

  it('holds output_handle while the history holds a handle', () => {
    expect(kinds(withHandle(base()))).toEqual(['output_handle']);
    expect(kinds(withHandle(compacted()))).toEqual(['history_range', 'output_handle']);
  });
});

describe('the replaced-range pointer names an offered reader only', () => {
  it('names the tool the readers map gives, not a constant', () => {
    const text = render(compacted(), { history_range: 'Recall' });
    expect(text).toContain('replaced: Recall seqFrom: 1, seqTo: 12');
    expect(text).not.toContain('HistoryRead');
  });

  it('names HistoryRead when the built tool list carries it', () => {
    expect(render(compacted(), { history_range: 'HistoryRead' })).toContain('replaced: HistoryRead seqFrom: 1, seqTo: 12');
  });

  it('names no tool and says the range is unreadable when no reader is offered', () => {
    const text = render(compacted(), {});
    expect(text).toContain(UNREADABLE);
    expect(text).not.toContain('HistoryRead');
  });

  it('gives the same unreadable text whether the reader was denied or dropped by the floor', () => {
    const denied = render(compacted(), { output_handle: 'ReadOutput' });
    const dropped = render(compacted(), {});
    expect(denied).toBe(dropped);
  });

  it('writes the pointer exactly when referenceKindsOf holds history_range', () => {
    const state = compacted();
    expect(referenceKindsOf(state)).toContain('history_range');
    expect(render(state, { history_range: 'HistoryRead' }).split('\n').filter((line) => line.startsWith('replaced:'))).toHaveLength(1);
  });
});
