import { describe, expect, it } from 'vitest';
import { marginFloorFor } from '@momonga/protocol';
import type { InputItem } from '@momonga/protocol';
import type { TokenMeter } from '@momonga/context';
import { ESTIMATED, EXACT, imagePiece, meterOf, piece, pieceCounter, toolOf } from './meter-fixtures.ts';

const W = 1600;

const reportOn = async (meter: TokenMeter, input: readonly InputItem[], reported: number) => {
  const counted = await meter.count({ input, tools: [] });
  meter.observe({ inputDigest: counted.inputDigest, inputTokens: reported });
  return counted;
};

describe('sigma, the shape of the reply that produced a part', () => {
  it('uses the estimated reply shape 3/10 with minimum 1 on an estimated target without a configured ratio', async () => {
    const meter = meterOf(pieceCounter(ESTIMATED), W, { tokenCounting: 'estimated' });
    const counted = await meter.count({ input: [piece('a', 100), piece('b', 100), piece('c', 100)], tools: [] });
    expect(counted.inputTokens).toBe(300);
    expect(counted.overTolerance).toBe(90);
    expect(counted.underAt(300)).toBe(90);
    expect(counted.freshUnderAt(300)).toBe(90);
    expect(counted.freshUnderAt(1)).toBe(1);
  });

  it('is zero at zero, so an empty part contributes nothing', async () => {
    const meter = meterOf(pieceCounter(ESTIMATED), W, { tokenCounting: 'estimated' });
    const counted = await meter.count({ input: [piece('a', 100)], tools: [] });
    expect(counted.freshUnderAt(0)).toBe(0);
    expect(counted.underAt(0)).toBe(0);
  });

  it('replaces the ratio of an estimated reply with the configured tokenErrorRatio and keeps its minimum', async () => {
    const meter = meterOf(pieceCounter(ESTIMATED), W, { tokenCounting: 'estimated', tokenErrorRatio: 0.5 });
    const counted = await meter.count({ input: [piece('a', 300)], tools: [] });
    expect(counted.overTolerance).toBe(150);
    expect(counted.freshUnderAt(300)).toBe(150);
    expect(counted.freshUnderAt(1)).toBe(1);
  });

  it('uses the calibrated reply shape on a calibrated target without a configured ratio', async () => {
    const meter = meterOf(pieceCounter({ method: 'calibrated', shape: { ratio: 0.25, minimum: 5 } }), W, { tokenCounting: 'calibrated' });
    const counted = await meter.count({ input: [piece('a', 400)], tools: [] });
    expect(counted.overTolerance).toBe(100);
    expect(counted.freshUnderAt(400)).toBe(100);
    expect(counted.freshUnderAt(8)).toBe(5);
  });

  it('replaces the ratio of a calibrated reply with the configured ratio and keeps the reply minimum', async () => {
    const meter = meterOf(pieceCounter({ method: 'calibrated', shape: { ratio: 0.25, minimum: 5 } }), W, { tokenCounting: 'calibrated', tokenErrorRatio: 0.125 });
    const counted = await meter.count({ input: [piece('a', 400)], tools: [] });
    expect(counted.overTolerance).toBe(50);
    expect(counted.freshUnderAt(400)).toBe(50);
    expect(counted.freshUnderAt(8)).toBe(5);
  });

  it('gives an exact reply no shape on an exact target without a configured ratio', async () => {
    const meter = meterOf(pieceCounter(EXACT), W);
    const counted = await meter.count({ input: [piece('a', 320)], tools: [] });
    expect(counted.overTolerance).toBe(0);
    expect(counted.freshUnderAt(320)).toBe(0);
  });

  it('applies a configured ratio to an exact reply on an exact target', async () => {
    const meter = meterOf(pieceCounter(EXACT), W, { tokenErrorRatio: 0.125 });
    const counted = await meter.count({ input: [piece('a', 320)], tools: [] });
    expect(counted.overTolerance).toBe(40);
    expect(counted.freshUnderAt(320)).toBe(40);
  });

  it('keeps the estimated shape of an image reply on an exact target with a configured ratio, because another method produced it', async () => {
    const meter = meterOf(pieceCounter(EXACT), W, { tokenErrorRatio: 0.125 });
    const counted = await meter.count({ input: [imagePiece('shot', 400)], tools: [] });
    expect(counted.overTolerance).toBe(120);
    expect(counted.freshUnderAt(400)).toBe(120);
  });
});

describe('the split against the latest report of the target', () => {
  it('extends a reported request: the known part is the kept report and only the new part is uncounted', async () => {
    const meter = meterOf(pieceCounter(ESTIMATED), W, { tokenCounting: 'estimated' });
    await reportOn(meter, [piece('a1', 100), piece('a2', 100)], 200);
    const counted = await meter.count({ input: [piece('a1', 100), piece('a2', 100), piece('b3', 50)], tools: [] });
    expect(counted.inputTokens).toBe(250);
    expect(counted.known).toBe(200);
    expect(counted.uncounted).toBe(50);
    expect(counted.overTolerance).toBe(15);
    expect(counted.underAt(250)).toBe(15);
    expect(counted.underAt(200)).toBe(0);
    expect(counted.underAt(260)).toBe(18);
    expect(counted.freshUnderAt(250)).toBe(75);
  });

  it('carries the known over-count O of a report below the count into the over side only', async () => {
    const meter = meterOf(pieceCounter(ESTIMATED), W, { tokenCounting: 'estimated' });
    await reportOn(meter, [piece('a1', 100), piece('a2', 100)], 170);
    const counted = await meter.count({ input: [piece('a1', 100), piece('a2', 100), piece('b3', 50)], tools: [] });
    expect(counted.inputTokens).toBe(250);
    expect(counted.known).toBe(200);
    expect(counted.uncounted).toBe(50);
    expect(counted.overTolerance).toBe(30 + 15);
    expect(counted.underAt(250)).toBe(15);
  });

  it('counts the suffix with the root tools minus their baseline', async () => {
    const tools = [toolOf('Read', 500)];
    const meter = meterOf(pieceCounter(ESTIMATED), W, { tokenCounting: 'estimated' });
    const first = await meter.count({ input: [piece('a1', 100)], tools });
    expect(first.inputTokens).toBe(600);
    meter.observe({ inputDigest: first.inputDigest, inputTokens: 600 });
    const counted = await meter.count({ input: [piece('a1', 100), piece('b2', 50)], tools });
    expect(counted.inputTokens).toBe(650);
    expect(counted.known).toBe(600);
    expect(counted.uncounted).toBe(50);
    expect(counted.underAt(650)).toBe(15);
  });

  it('after a compaction, counts the replaced working state of the report as a dropped part', async () => {
    const meter = meterOf(pieceCounter(ESTIMATED), W, { tokenCounting: 'estimated' });
    await reportOn(meter, [piece('a1', 100), piece('a2', 100), piece('ws1', 40)], 240);
    const counted = await meter.count({ input: [piece('a1', 100), piece('a2', 100), piece('b3', 50), piece('ws2', 60)], tools: [] });
    expect(counted.inputTokens).toBe(310);
    expect(counted.known).toBe(200);
    expect(counted.uncounted).toBe(150);
    expect(counted.overTolerance).toBe(12 + 33);
    expect(counted.underAt(310)).toBe(45);
    expect(counted.underAt(150)).toBe(12);
    expect(counted.underAt(200)).toBe(12);
    expect(counted.underAt(210)).toBe(12 + 3);
  });

  it('uses the fresh count when it gives the smaller bound on the server count, as after this eviction', async () => {
    const meter = meterOf(pieceCounter(ESTIMATED), W, { tokenCounting: 'estimated' });
    await reportOn(meter, [piece('a1', 100), piece('a2', 100), piece('a3', 100)], 300);
    const counted = await meter.count({ input: [piece('a1', 100), piece('a3', 100)], tools: [] });
    expect(counted.inputTokens).toBe(200);
    expect(counted.known).toBe(0);
    expect(counted.uncounted).toBe(200);
    expect(counted.overTolerance).toBe(60);
    expect(counted.underAt(200)).toBe(60);
  });

  it('breaks a tie between the two bounds toward the split', async () => {
    const meter = meterOf(pieceCounter(ESTIMATED), W, { tokenCounting: 'estimated' });
    await reportOn(meter, [piece('p', 10), piece('d', 10)], 20);
    const counted = await meter.count({ input: [piece('p', 10), piece('n', 10)], tools: [] });
    expect(counted.inputTokens).toBe(20);
    expect(counted.known).toBe(10);
    expect(counted.uncounted).toBe(20);
    expect(counted.underAt(20)).toBe(6);
  });

  it('uses the fresh count when the root differs, as when the tools change', async () => {
    const meter = meterOf(pieceCounter(ESTIMATED), W, { tokenCounting: 'estimated' });
    await reportOn(meter, [piece('a1', 100)], 100);
    const counted = await meter.count({ input: [piece('a1', 100), piece('b2', 50)], tools: [toolOf('Read', 500)] });
    expect(counted.inputTokens).toBe(650);
    expect(counted.known).toBe(0);
    expect(counted.uncounted).toBe(650);
    expect(counted.overTolerance).toBe(195);
  });

  it('uses the fresh count when the known part would be negative', async () => {
    const shrinking = pieceCounter({
      ...ESTIMATED,
      extra: (input) => (input[0] !== undefined && (input[0] as { content: string }).content === 'q#0' ? 500 : 0),
    });
    const meter = meterOf(shrinking, W, { tokenCounting: 'estimated' });
    await reportOn(meter, [piece('a1', 100), piece('q', 0)], 100);
    const counted = await meter.count({ input: [piece('a1', 100), piece('b2', 50)], tools: [] });
    expect(counted.inputTokens).toBe(150);
    expect(counted.known).toBe(0);
    expect(counted.uncounted).toBe(150);
  });
});

describe('the under side is non-decreasing in the size', () => {
  it('holds for the split and the fresh bound over every size up to 2000', async () => {
    const meter = meterOf(pieceCounter(ESTIMATED), W, { tokenCounting: 'estimated' });
    await reportOn(meter, [piece('a1', 100), piece('ws1', 40)], 300);
    const counted = await meter.count({ input: [piece('a1', 100), piece('b2', 70), piece('ws2', 30)], tools: [] });
    for (let m = 1; m <= 2000; m += 1) {
      expect(counted.underAt(m)).toBeGreaterThanOrEqual(counted.underAt(m - 1));
      expect(counted.freshUnderAt(m)).toBeGreaterThanOrEqual(counted.freshUnderAt(m - 1));
    }
  });
});

describe('the observed excess E', () => {
  it('adds the shape and E for an estimated counter instead of taking their maximum', async () => {
    const meter = meterOf(pieceCounter(ESTIMATED), W, { tokenCounting: 'estimated' });
    await reportOn(meter, [piece('a', 100)], 200);
    const counted = await meter.count({ input: [piece('z', 100)], tools: [] });
    expect(counted.freshUnderAt(100)).toBe(30 + (70 - marginFloorFor(W)));
  });

  it('scales a miss by v / u_i and subtracts the margin floor after scaling', async () => {
    const meter = meterOf(pieceCounter(EXACT), W);
    await reportOn(meter, [piece('a', 100)], 150);
    const counted = await meter.count({ input: [piece('a', 100), piece('b', 200)], tools: [] });
    expect(counted.inputTokens).toBe(350);
    expect(counted.known).toBe(150);
    expect(counted.uncounted).toBe(200);
    expect(counted.underAt(350)).toBe(100 - 32);
    expect(counted.underAt(150)).toBe(50 - 32);
    expect(counted.underAt(250)).toBe(50 - 32);
    expect(counted.underAt(300)).toBe(75 - 32);
    expect(counted.freshUnderAt(300)).toBe(150 - 32);
    expect(counted.freshUnderAt(50)).toBe(50 - 32);
  });

  it('does not scale a miss measured on an uncounted size of zero, a resend', async () => {
    const meter = meterOf(pieceCounter(EXACT), W);
    await reportOn(meter, [piece('a', 100)], 100);
    const resent = await reportOn(meter, [piece('a', 100)], 180);
    expect(resent.uncounted).toBe(0);
    const counted = await meter.count({ input: [piece('a', 100), piece('b', 1000)], tools: [] });
    expect(counted.underAt(counted.inputTokens)).toBe(80 - 32);
    expect(counted.freshUnderAt(1100)).toBe(80 - 32);
  });

  it('keeps a miss for the last 20 reports of the target and drops it with the 21st', async () => {
    const meter = meterOf(pieceCounter(EXACT), W);
    await reportOn(meter, [piece('a', 100)], 300);
    const probe = async () => (await meter.count({ input: [piece('z', 100)], tools: [] })).freshUnderAt(100);
    expect(await probe()).toBe(200 - 32);
    for (let report = 0; report < 19; report += 1) await reportOn(meter, [piece('a', 100)], 100);
    expect(await probe()).toBe(200 - 32);
    await reportOn(meter, [piece('a', 100)], 100);
    expect(await probe()).toBe(0);
  });

  it('takes the maximum over the window', async () => {
    const meter = meterOf(pieceCounter(EXACT), W);
    await reportOn(meter, [piece('a', 100)], 180);
    await reportOn(meter, [piece('c', 400)], 450);
    const counted = await meter.count({ input: [piece('z', 400)], tools: [] });
    expect(counted.freshUnderAt(400)).toBe(Math.max(320 - 32, 50 - 32));
    expect(counted.freshUnderAt(100)).toBe(Math.max(80 - 32, 50 - 32));
  });

  it('is computed exactly in BigInt where miss times v exceeds 2^53', async () => {
    const window = 2 ** 33;
    const u = 8193;
    const miss = 2 ** 32 + 1;
    const v = 2 ** 33 - 1;
    const floor = marginFloorFor(window);
    expect(floor).toBe(171798692);
    const exact = (BigInt(miss) * BigInt(v) + BigInt(u) - 1n) / BigInt(u) - BigInt(floor);
    expect(exact).toBe(4503049767382814n);
    expect(BigInt(Math.ceil((miss * v) / u) - floor)).not.toBe(exact);
    const meter = meterOf(pieceCounter(EXACT), window, { maxOutputTokens: 4096 });
    await reportOn(meter, [piece('a', u)], u + miss);
    const counted = await meter.count({ input: [piece('z', 1)], tools: [] });
    expect(counted.freshUnderAt(v)).toBe(Number(exact));
  });
});

describe('the removed floor and cap', () => {
  it('has no relative error on the meter', () => {
    const meter = meterOf(pieceCounter(ESTIMATED), W, { tokenCounting: 'estimated' });
    expect('relativeError' in meter).toBe(false);
  });

  it('adds no 10 percent floor to an estimated target whose configured ratio is below it', async () => {
    const meter = meterOf(pieceCounter(ESTIMATED), W, { tokenCounting: 'estimated', tokenErrorRatio: 0.0625 });
    const counted = await meter.count({ input: [piece('a', 1000)], tools: [] });
    expect(counted.freshUnderAt(1000)).toBe(63);
    expect(counted.overTolerance).toBe(63);
  });

  it('does not cap a miss larger than the input at the size of the input', async () => {
    const meter = meterOf(pieceCounter(EXACT), W);
    await reportOn(meter, [piece('a', 100)], 500);
    const counted = await meter.count({ input: [piece('z', 100)], tools: [] });
    expect(counted.freshUnderAt(100)).toBe(400 - 32);
  });
});

describe('the calibrated shape on the over side', () => {
  it('lets a calibrated count exceed the report by more than the margin floor but within its shape', async () => {
    const meter = meterOf(pieceCounter({ method: 'calibrated', shape: { ratio: 0.25, minimum: 1 } }), W, { tokenCounting: 'calibrated', tokenErrorRatio: 0.25 });
    const counted = await meter.count({ input: [piece('a', 1000)], tools: [] });
    expect(counted.overTolerance).toBe(250);
    const reported = 820;
    expect(counted.inputTokens - reported).toBeGreaterThan(marginFloorFor(W));
    expect(reported < counted.inputTokens - (marginFloorFor(W) + counted.overTolerance)).toBe(false);
  });
});

describe('observe', () => {
  it('returns the journaled fields of the report', async () => {
    const meter = meterOf(pieceCounter(ESTIMATED), W, { tokenCounting: 'estimated' });
    await reportOn(meter, [piece('a1', 100), piece('a2', 100)], 170);
    const counted = await meter.count({ input: [piece('a1', 100), piece('a2', 100), piece('b3', 50)], tools: [] });
    const observed = meter.observe({ inputDigest: counted.inputDigest, inputTokens: 240 });
    expect(observed).toEqual({
      inputDigest: counted.inputDigest,
      itemCount: 3,
      counted: 250,
      reported: 240,
      kept: 250,
      known: 200,
      uncounted: 50,
      shape: { ratio: 0.3, minimum: 1 },
      contextWindow: W,
      tokenCounting: 'estimated',
    });
  });
});
