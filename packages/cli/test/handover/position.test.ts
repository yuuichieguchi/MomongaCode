import { describe, expect, it } from 'vitest';
import { positionOf } from '../../src/tui/handover.ts';

const noEntry = { entryOf: () => undefined };

describe('the view of a handover whose key is not found (P-310)', () => {
  it('keeps the view where the person had it instead of following the end', () => {
    expect(positionOf({ key: { runId: 'run-1', seq: 9, index: 0 }, rowOffset: 4, following: false }, noEntry)).toEqual({ anchor: undefined, following: false });
  });

  it('keeps following when the person was following', () => {
    expect(positionOf({ key: { runId: 'run-1', seq: 9, index: 0 }, rowOffset: 0, following: true }, noEntry)).toEqual({ anchor: undefined, following: true });
  });
});
