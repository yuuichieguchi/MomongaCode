import { describe, expect, it } from 'vitest';
import { MIN_ROOM_TOKENS, inputCeilingFor, itemCapFor, pinnedFloorFor } from '@momonga/context';
import { ESTIMATED_ERROR, ITEM_CAP, ITEM_ROOM, MARGIN, MAX_OUTPUT_WINDOW, MIN_MARGIN, OUTPUT_RESERVE } from '@momonga/protocol';
import type { Capabilities, CapabilityOverride } from '@momonga/protocol';
import { summaryInputCeilingFor } from '../src/budget.ts';
import { capabilitiesFor } from './helpers.ts';

type Ratio = { readonly num: number; readonly den: number };

const DOMAIN = 2 ** 33;
const EXHAUSTIVE_LIMIT = 2 ** 16;
const RANDOM_POINTS = 100_000;
const SWEEP_TIMEOUT_MS = 240_000;
const MIN_OUTPUT_RESERVE = 256n;
const MIN_ITEM_CAP = 64n;
const MAX_OUTPUT_TOKENS = 4096;
const QUANTUM = 2 ** 20;

const seededRandom = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
};

const sweepPoints = (seed: number, from: number): number[] => {
  const random = seededRandom(seed);
  const points: number[] = [];
  for (let x = from; x <= EXHAUSTIVE_LIMIT; x += 1) points.push(x);
  for (let index = 0; index < RANDOM_POINTS; index += 1) points.push(Math.max(from, Math.floor(random() * (DOMAIN + 1))));
  points.push(DOMAIN, DOMAIN - 1);
  return points;
};

const big = (value: number): bigint => BigInt(value);
const minBig = (...values: bigint[]): bigint => values.reduce((low, value) => (value < low ? value : low));
const maxBig = (...values: bigint[]): bigint => values.reduce((high, value) => (value > high ? value : high));
const ceilBig = (ratio: Ratio, x: bigint): bigint => (big(ratio.num) * x + big(ratio.den) - 1n) / big(ratio.den);
const floorBig = (ratio: Ratio, x: bigint): bigint => (big(ratio.num) * x) / big(ratio.den);
const floorDivBig = (numerator: bigint, denominator: bigint): bigint =>
  numerator >= 0n ? numerator / denominator : -((-numerator + denominator - 1n) / denominator);

const firstMismatch = (points: readonly number[], actual: (x: number) => number, expected: (x: number) => bigint): number | undefined =>
  points.find((x) => big(actual(x)) !== expected(x));

const inputBudgetOf = (W: bigint): bigint => {
  const margin = maxBig(ceilBig(MARGIN, W), big(MIN_MARGIN));
  const reserve = minBig(big(MAX_OUTPUT_TOKENS), maxBig(MIN_OUTPUT_RESERVE, ceilBig(OUTPUT_RESERVE, W)), floorBig(MAX_OUTPUT_WINDOW, W));
  return W - reserve - margin;
};

const ceilingOf = (W: bigint, sizing: Ratio): bigint =>
  maxBig(0n, floorDivBig(inputBudgetOf(W) * big(sizing.den), big(sizing.den) + big(sizing.num)));

type Counting = { readonly label: string; readonly override: CapabilityOverride; readonly sizing: () => Ratio };

const countings: readonly Counting[] = [
  { label: 'exact', override: { tokenCounting: 'exact' }, sizing: () => ({ num: 0, den: 1 }) },
  { label: 'estimated', override: { tokenCounting: 'estimated' }, sizing: () => ESTIMATED_ERROR },
  { label: 'calibrated without a configured ratio', override: { tokenCounting: 'calibrated' }, sizing: () => ESTIMATED_ERROR },
  {
    label: 'calibrated with ratio 314573/2^20',
    override: { tokenCounting: 'calibrated', tokenErrorRatio: 314_573 / QUANTUM },
    sizing: () => ({ num: 314_573, den: QUANTUM }),
  },
  {
    label: 'estimated with ratio 1/2^20',
    override: { tokenCounting: 'estimated', tokenErrorRatio: 1 / QUANTUM },
    sizing: () => ({ num: 1, den: QUANTUM }),
  },
  {
    label: 'estimated with ratio 2^20/2^20',
    override: { tokenCounting: 'estimated', tokenErrorRatio: 1 },
    sizing: () => ({ num: QUANTUM, den: QUANTUM }),
  },
];

const capabilitiesOf = (W: number, counting: Counting): Capabilities =>
  capabilitiesFor(W, { maxOutputTokens: MAX_OUTPUT_TOKENS, ...counting.override });

describe('ratio-sweep tie: context budget functions equal their exact rational definitions', () => {
  it.each(countings.map((counting) => [counting.label, counting] as const))(
    'inputCeilingFor = max(0, floor(I0 / (1 + sizingRatio))) for %s counting',
    (_label, counting) => {
      const points = sweepPoints(11, 1);
      expect(firstMismatch(points, (W) => inputCeilingFor(capabilitiesOf(W, counting)), (W) => ceilingOf(big(W), counting.sizing()))).toBeUndefined();
    },
    SWEEP_TIMEOUT_MS,
  );

  it.each(countings.map((counting) => [counting.label, counting] as const))(
    'pinnedFloorFor = ceiling - max(MIN_ROOM_TOKENS, ceil(ceiling/4)) for %s counting',
    (_label, counting) => {
      const points = sweepPoints(12, 1);
      const expected = (W: number): bigint => {
        const ceiling = ceilingOf(big(W), counting.sizing());
        return ceiling - maxBig(big(MIN_ROOM_TOKENS), ceilBig(ITEM_CAP, ceiling));
      };
      expect(firstMismatch(points, (W) => pinnedFloorFor(capabilitiesOf(W, counting)), expected)).toBeUndefined();
    },
    SWEEP_TIMEOUT_MS,
  );

  it.each(countings.map((counting) => [counting.label, counting] as const))(
    'summaryInputCeilingFor = max(0, min(floor((W - marginFloor) / (1 + sizingRatio)), W - R)) for %s counting',
    (_label, counting) => {
      const points = sweepPoints(15, 1);
      const expected = (W: number): bigint => {
        const w = big(W);
        const sizing = counting.sizing();
        const margin = maxBig(ceilBig(MARGIN, w), big(MIN_MARGIN));
        const reserve = minBig(big(MAX_OUTPUT_TOKENS), maxBig(MIN_OUTPUT_RESERVE, ceilBig(OUTPUT_RESERVE, w)), floorBig(MAX_OUTPUT_WINDOW, w));
        return maxBig(0n, minBig(floorDivBig((w - margin) * big(sizing.den), big(sizing.den) + big(sizing.num)), w - reserve));
      };
      expect(firstMismatch(points, (W) => summaryInputCeilingFor(capabilitiesOf(W, counting)), expected)).toBeUndefined();
    },
    SWEEP_TIMEOUT_MS,
  );

  it(
    'itemCapFor = max(64, floor(I0/4)), and with a room max(64, min(base, floor(room/2)))',
    () => {
      const estimated = countings[1] as Counting;
      const windows = sweepPoints(13, 1);
      const base = (W: number): bigint => maxBig(MIN_ITEM_CAP, floorBig(ITEM_CAP, maxBig(0n, inputBudgetOf(big(W)))));
      expect(firstMismatch(windows, (W) => itemCapFor(capabilitiesOf(W, estimated)), base)).toBeUndefined();
      const rooms = sweepPoints(14, 0);
      for (const W of [8192, 200_000, DOMAIN]) {
        const capabilities = capabilitiesOf(W, estimated);
        const withRoom = (room: number): bigint => maxBig(MIN_ITEM_CAP, minBig(base(W), floorBig(ITEM_ROOM, big(room))));
        expect(firstMismatch(rooms, (room) => itemCapFor(capabilities, room), withRoom)).toBeUndefined();
      }
    },
    SWEEP_TIMEOUT_MS,
  );

  it('reproduces the 4.4 example at W 8192 with maxOutputTokens 1024 and estimated counting', () => {
    const capabilities = capabilitiesFor(8192, { maxOutputTokens: 1024, tokenCounting: 'estimated' });
    expect(inputCeilingFor(capabilities)).toBe(5387);
    expect(itemCapFor(capabilities, 5387 - 2900)).toBe(1243);
  });
});
