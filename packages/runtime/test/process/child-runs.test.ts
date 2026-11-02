import { describe, expect, it } from 'vitest';
import { foldRunState, initialRunState } from '@momonga/store';
import type { RunEvent } from '@momonga/protocol';
import { finalTextOf } from '@momonga/runtime';

const envelope = (seq: number) => ({ id: seq, runId: 'r', sessionId: 's', seq, step: 1, leaseToken: 1, createdAt: 0 });

const responded = (seq: number, output: unknown[]): RunEvent => ({
  type: 'model.responded',
  attempt: 1,
  response: { status: 'completed', output, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
  ...envelope(seq),
});

const message = (text: string) => ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });

describe('the final text of a run', () => {
  const fold = (events: RunEvent[]) => events.reduce(foldRunState, initialRunState({ runId: 'r', sessionId: 's' }));

  it('is the last assistant message, joined across its text parts', () => {
    const state = fold([
      responded(1, [message('first')]),
      responded(2, [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'a' }, { type: 'output_text', text: 'b' }] }]),
    ]);
    expect(finalTextOf(state)).toBe('ab');
  });

  it('skips trailing items that are not assistant text', () => {
    const state = fold([responded(1, [message('answer'), { type: 'function_call', call_id: 'c', name: 'X', arguments: '{}' }])]);
    expect(finalTextOf(state)).toBe('answer');
  });

  it('is empty when the run said nothing', () => {
    expect(finalTextOf(fold([]))).toBe('');
  });
});
