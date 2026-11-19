import { describe, expect, it } from 'vitest';
import { budgetFor } from '@momonga/context';
import type { HistoryItem } from '@momonga/context';
import { marginFloorFor } from '@momonga/protocol';
import { assistant, capabilitiesFor, harness, inputFor, overflowOf, sourcesWith, user } from './helpers.ts';

const WINDOW = 4000;
const LISTED_RATIO = 0.5;

const inheritedTurn = (textLength: number): HistoryItem[] => [user(1, 'q0 '.padEnd(textLength, 'q')), assistant(2, 'a0 '.padEnd(textLength, 'a'))];

const summaryCeilingAt = (ratio: number): number => {
  const { W, R } = budgetFor(capabilitiesFor(WINDOW), 0, 0);
  return Math.min(Math.floor((W - marginFloorFor(W)) / (1 + ratio)), W - R);
};

describe('the compaction input ceiling with the calibration of the claim listing', () => {
  it('takes the ratio from the listed calibration and the window from the pinned capabilities', async () => {
    const pinned = capabilitiesFor(WINDOW);
    const sources = sourcesWith({ taskSeq: 3, history: inheritedTurn(8000) });
    const listed = summaryCeilingAt(LISTED_RATIO);
    expect(listed).toBeLessThan(summaryCeilingAt(0));

    const error = await overflowOf({ ...inputFor(pinned, { sources, level: 1 }), calibration: { tokenCounting: 'exact', tokenErrorRatio: LISTED_RATIO } }, harness(pinned).ports);

    expect(error.compactionBlockedBy?.reason).toBe('region_exceeds_summary_input_budget');
    expect(error.compactionBlockedBy?.message).toContain(`more than the ${listed} a summary request may hold`);
  });
});
