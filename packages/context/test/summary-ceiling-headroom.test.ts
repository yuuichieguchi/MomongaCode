import { describe, expect, it } from 'vitest';
import { summaryInputCeilingFor } from '../src/budget.ts';
import { largestSummaryCapFor, marginFloorFor, reasoningHeadroomFor, summaryRequestInputLimitFor } from '@momonga/protocol';
import { capabilitiesFor } from './helpers.ts';

const W = 8000;

describe('the summary input ceiling takes the reasoning headroom the gateway reserves', () => {
  const caps = capabilitiesFor(W, { maxOutputTokens: 16_384, reasoning: { control: 'none', headroomTokens: 2048 } });
  const cap = largestSummaryCapFor(caps);

  it('has a reasoning headroom at the summary cap below the largest output', () => {
    expect(reasoningHeadroomFor(caps, cap)).toBe(2048);
  });

  it('leaves room for the summary cap and the headroom, as the gateway checks them', () => {
    const ceiling = summaryInputCeilingFor(caps, cap);
    expect(ceiling).toBeLessThanOrEqual(W - 2048 - marginFloorFor(W));
    expect(ceiling).toBeLessThanOrEqual(summaryRequestInputLimitFor(caps, cap) + cap);
  });
});
