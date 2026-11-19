import { describe, expect, it } from 'vitest';
import { budgetFor } from '@momonga/context';
import { marginFloorFor, outputReserveFor } from '@momonga/protocol';
import type { InputItem } from '@momonga/protocol';
import { capabilitiesFor } from './helpers.ts';
import { ESTIMATED, meterOf, piece, pieceCounter } from './meter-fixtures.ts';

describe('the meter agrees with the B8m counterexample of meter-sides.test.ts', () => {
  const capabilities = { tokenCounting: 'estimated', maxOutputTokens: 39 } as const;
  const contentOf = (item: InputItem): unknown => (item as { content?: unknown }).content;
  const bothNewAndOld = (input: readonly InputItem[]): number =>
    input.some((item) => contentOf(item) === 'p#0') && input.some((item) => contentOf(item) === 'n#4') ? 1 : 0;

  it('uses the split count 4 with its own bound 3, so the fit test refuses the input whose server count 39 exceeds W - R', async () => {
    const meter = meterOf(pieceCounter({ ...ESTIMATED, extra: bothNewAndOld }), 76, capabilities);
    const first = await meter.count({ input: [piece('p', 0), piece('d', 1)], tools: [] });
    expect(first.inputTokens).toBe(1);
    meter.observe({ inputDigest: first.inputDigest, inputTokens: 1 });

    const counted = await meter.count({ input: [piece('p', 0), piece('n', 4)], tools: [] });

    const I0 = budgetFor(capabilitiesFor(76, capabilities), 0, 0).I;
    expect(marginFloorFor(76)).toBe(32);
    expect(outputReserveFor({ contextWindow: 76, maxOutputTokens: 39 })).toBe(38);
    expect(I0).toBe(6);
    expect(counted.inputTokens).toBe(4);
    expect(counted.known).toBe(0);
    expect(counted.uncounted).toBe(5);
    expect(counted.underAt(4)).toBe(3);
    expect(counted.freshUnderAt(4)).toBe(2);
    expect(counted.inputTokens + counted.underAt(counted.inputTokens)).toBeGreaterThan(I0);
    expect(counted.inputTokens + Math.min(counted.underAt(4), counted.freshUnderAt(4))).toBeLessThanOrEqual(I0);
    expect(39).toBeGreaterThan(76 - 38);
  });
});

describe('the meter agrees with a B8 (i) and (ii) witness at the extremes of the hypotheses', () => {
  const W = 1600;
  const restA = 40;
  const restB = 60;
  const reportedA = 140;
  const sigmaA = 12;
  const sigmaB = 18;
  const floor = 32;

  const splitCount = async () => {
    const meter = meterOf(pieceCounter(ESTIMATED), W, { tokenCounting: 'estimated' });
    const first = await meter.count({ input: [piece('p', 100), piece('d', restA)], tools: [] });
    meter.observe({ inputDigest: first.inputDigest, inputTokens: reportedA });
    return meter.count({ input: [piece('p', 100), piece('n', restB)], tools: [] });
  };

  it('B8 (i): the bound covers the largest server count the hypotheses allow', async () => {
    const counted = await splitCount();
    const lowestA = restA - sigmaA - floor / 2;
    const highestB = restB + sigmaB + floor / 2;
    const worstServer = reportedA - lowestA + highestB;
    expect(counted.inputTokens).toBe(160);
    expect(counted.known).toBe(100);
    expect(counted.uncounted).toBe(restA + restB);
    expect(counted.underAt(160)).toBe(sigmaA + sigmaB);
    expect(worstServer).toBe(222);
    expect(counted.inputTokens + counted.underAt(counted.inputTokens) + marginFloorFor(W)).toBe(worstServer);
  });

  it('B8 (ii): the smallest server count the hypotheses allow is not flagged, and one token less is', async () => {
    const counted = await splitCount();
    const highestA = restA + sigmaA + floor / 2;
    const lowestB = restB - sigmaB - floor / 2;
    const leastServer = reportedA - highestA + lowestB;
    expect(leastServer).toBe(98);
    expect(counted.overTolerance).toBe(sigmaA + sigmaB);
    const flagged = (report: number): boolean => report < counted.inputTokens - (marginFloorFor(W) + counted.overTolerance);
    expect(flagged(leastServer)).toBe(false);
    expect(flagged(leastServer - 1)).toBe(true);
  });
});
