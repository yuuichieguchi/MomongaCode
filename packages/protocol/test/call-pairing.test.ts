import { describe, expect, it } from 'vitest';
import { findDanglingOutput, findUnpairedCalls } from '@momonga/protocol';
import type { InputItem } from '@momonga/protocol';

const callAt = (seq: number, callId: string): { seq: number; item: InputItem } => ({
  seq,
  item: { type: 'function_call', call_id: callId, name: 'Read', arguments: '{}' },
});
const outputAt = (seq: number, callId: string): { seq: number; item: InputItem } => ({
  seq,
  item: { type: 'function_call_output', call_id: callId, output: 'x' },
});
const userAt = (seq: number): { seq: number; item: InputItem } => ({ seq, item: { type: 'message', role: 'user', content: 'q' } });

describe('findDanglingOutput', () => {
  it('reports an output that precedes the only retained call with a reused provider id', () => {
    expect(findDanglingOutput([outputAt(2, 'call_0'), callAt(3, 'call_0'), outputAt(4, 'call_0')])).toEqual({ callId: 'call_0', seq: 2 });
  });

  it('reports the second output of a call that was already paired', () => {
    expect(findDanglingOutput([callAt(1, 'c1'), outputAt(2, 'c1'), outputAt(3, 'c1')])).toEqual({ callId: 'c1', seq: 3 });
  });

  it('finds nothing in a well-formed interleaving with reused and parallel ids', () => {
    expect(
      findDanglingOutput([
        userAt(1),
        callAt(2, 'call_0'),
        callAt(3, 'c2'),
        outputAt(4, 'c2'),
        outputAt(5, 'call_0'),
        callAt(6, 'call_0'),
        outputAt(7, 'call_0'),
      ]),
    ).toBeUndefined();
  });

  it('finds nothing in an empty history', () => {
    expect(findDanglingOutput([])).toBeUndefined();
  });
});

describe('findUnpairedCalls', () => {
  it('returns every function_call without a later output, in history order', () => {
    expect(
      findUnpairedCalls([userAt(1), callAt(2, 'c1'), callAt(3, 'c2'), outputAt(4, 'c2'), callAt(5, 'c3')]),
    ).toEqual([
      { seq: 2, callId: 'c1' },
      { seq: 5, callId: 'c3' },
    ]);
  });

  it('returns nothing when every call is answered, including parallel calls answered out of order', () => {
    expect(findUnpairedCalls([userAt(1), callAt(2, 'c1'), callAt(3, 'c2'), outputAt(4, 'c2'), outputAt(5, 'c1')])).toEqual([]);
  });

  it('does not treat an output that precedes its call as pairing it', () => {
    expect(findUnpairedCalls([outputAt(1, 'c1'), callAt(2, 'c1')])).toEqual([{ seq: 2, callId: 'c1' }]);
  });

  it('returns nothing for an empty history', () => {
    expect(findUnpairedCalls([])).toEqual([]);
  });
});
