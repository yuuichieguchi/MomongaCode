import { describe, expect, it } from 'vitest';
import {
  COMPACTION_MIN_GAIN,
  COMPACT_AT,
  ESTIMATED_ERROR,
  EVICT_LOW_WATER,
  ITEM_CAP,
  ITEM_ROOM,
  MARGIN,
  MAX_OUTPUT_WINDOW,
  MAX_SUMMARY_TOKENS,
  MIN_MARGIN,
  MIN_SUMMARY_TOKENS,
  OUTPUT_RESERVE,
  SUMMARY_ACCEPT,
  SUMMARY_ITEM_OVERHEAD,
  SUMMARY_ROOM,
  SUMMARY_WINDOW,
  ceilRatio,
  floorRatio,
  marginFloorFor,
  outputReserveFor,
  summaryInputLimitFor,
  summaryItemTokensFor,
  summaryTokenCapFor,
} from '@momonga/protocol';
import type { Capabilities } from '@momonga/protocol';

type Ratio = { readonly num: number; readonly den: number };

const DOMAIN = 2 ** 33;
const EXHAUSTIVE_LIMIT = 2 ** 16;
const RANDOM_POINTS = 100_000;
const SWEEP_TIMEOUT_MS = 120_000;
const MIN_OUTPUT_RESERVE = 256n;

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

const sweepPoints = (seed: number, from = 0): number[] => {
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
const ceilExact = (ratio: Ratio, x: number): number => Number(ceilBig(ratio, big(x)));
const floorExact = (ratio: Ratio, x: number): number => Number(floorBig(ratio, big(x)));

const firstMismatch = (points: readonly number[], actual: (x: number) => number, expected: (x: number) => number): number | undefined =>
  points.find((x) => actual(x) !== expected(x));

const capabilitiesOf = (contextWindow: number, maxOutputTokens: number): Capabilities => ({
  contextWindow,
  maxOutputTokens,
  toolCalling: 'native',
  structuredOutput: 'json_schema',
  streaming: true,
  stopSequences: false,
  imageInput: false,
  parallelToolCalls: true,
  schemaDialect: 'json-schema-2020-12',
  tokenCounting: 'estimated',
  usageReported: true,
  maxConcurrency: 1,
  source: 'declared',
});

const marginOf = (W: bigint): bigint => maxBig(ceilBig(MARGIN, W), big(MIN_MARGIN));
const reserveOf = (W: bigint, maxOutput: bigint): bigint =>
  minBig(maxOutput, maxBig(MIN_OUTPUT_RESERVE, ceilBig(OUTPUT_RESERVE, W)), floorBig(MAX_OUTPUT_WINDOW, W));

describe('budget ratios are exact fractions', () => {
  it('declares every ratio of the budget as num over den', () => {
    expect(MARGIN).toEqual({ num: 1, den: 50 });
    expect(OUTPUT_RESERVE).toEqual({ num: 1, den: 4 });
    expect(MAX_OUTPUT_WINDOW).toEqual({ num: 1, den: 2 });
    expect(ESTIMATED_ERROR).toEqual({ num: 3, den: 10 });
    expect(SUMMARY_WINDOW).toEqual({ num: 6, den: 100 });
    expect(SUMMARY_ROOM).toEqual({ num: 3, den: 10 });
    expect(SUMMARY_ACCEPT).toEqual({ num: 13, den: 10 });
    expect(ITEM_CAP).toEqual({ num: 1, den: 4 });
    expect(ITEM_ROOM).toEqual({ num: 1, den: 2 });
    expect(COMPACT_AT).toEqual({ num: 7, den: 10 });
    expect(EVICT_LOW_WATER).toEqual({ num: 1, den: 2 });
    expect(COMPACTION_MIN_GAIN).toEqual({ num: 2, den: 1 });
  });

  it('rounds 7/10 of 90 to 63 where the floating product 0.7 * 90 floors to 62', () => {
    expect(Math.floor(0.7 * 90)).toBe(62);
    expect(floorRatio(COMPACT_AT, 90)).toBe(63);
    expect(ceilRatio(COMPACT_AT, 90)).toBe(63);
    expect(floorRatio(COMPACT_AT, 91)).toBe(63);
    expect(ceilRatio(COMPACT_AT, 91)).toBe(64);
  });

  it('computes hand-checked values exactly', () => {
    expect(ceilRatio(MARGIN, 8192)).toBe(164);
    expect(floorRatio(MARGIN, 8192)).toBe(163);
    expect(ceilRatio(SUMMARY_ACCEPT, 64)).toBe(84);
    expect(floorRatio(SUMMARY_ACCEPT, 64)).toBe(83);
    expect(floorRatio(COMPACT_AT, 2487)).toBe(1740);
    expect(ceilRatio(ESTIMATED_ERROR, 0)).toBe(0);
    expect(floorRatio(COMPACTION_MIN_GAIN, 2 ** 33)).toBe(2 ** 34);
  });

  it('accepts 2^33 and refuses anything above it with a RangeError', () => {
    expect(floorRatio(SUMMARY_ACCEPT, DOMAIN)).toBe(11_166_914_969);
    expect(ceilRatio(SUMMARY_ACCEPT, DOMAIN)).toBe(11_166_914_970);
    expect(() => floorRatio(COMPACT_AT, DOMAIN + 1)).toThrow(RangeError);
    expect(() => ceilRatio(COMPACT_AT, DOMAIN + 1)).toThrow(RangeError);
    expect(() => ceilRatio(MARGIN, 2 ** 40)).toThrow(RangeError);
  });

  const ratios: ReadonlyArray<readonly [string, () => Ratio]> = [
    ['MARGIN', () => MARGIN],
    ['OUTPUT_RESERVE', () => OUTPUT_RESERVE],
    ['MAX_OUTPUT_WINDOW', () => MAX_OUTPUT_WINDOW],
    ['ESTIMATED_ERROR', () => ESTIMATED_ERROR],
    ['SUMMARY_WINDOW', () => SUMMARY_WINDOW],
    ['SUMMARY_ROOM', () => SUMMARY_ROOM],
    ['SUMMARY_ACCEPT', () => SUMMARY_ACCEPT],
    ['ITEM_CAP', () => ITEM_CAP],
    ['ITEM_ROOM', () => ITEM_ROOM],
    ['COMPACT_AT', () => COMPACT_AT],
    ['EVICT_LOW_WATER', () => EVICT_LOW_WATER],
    ['COMPACTION_MIN_GAIN', () => COMPACTION_MIN_GAIN],
  ];

  it.each(ratios)(
    'ceilRatio and floorRatio of %s equal BigInt rational arithmetic over the sweep',
    (_name, ratioOf) => {
      const ratio = ratioOf();
      const points = sweepPoints(ratio.num * 1000 + ratio.den);
      expect(firstMismatch(points, (x) => ceilRatio(ratio, x), (x) => ceilExact(ratio, x))).toBeUndefined();
      expect(firstMismatch(points, (x) => floorRatio(ratio, x), (x) => floorExact(ratio, x))).toBeUndefined();
    },
    SWEEP_TIMEOUT_MS,
  );

  it(
    'is exact for a calibrated ratio quantized to 2^-20 with numerator up to 2^20',
    () => {
      const points = sweepPoints(20);
      for (const num of [1, 314_573, 2 ** 20]) {
        const ratio = { num, den: 2 ** 20 };
        expect(firstMismatch(points, (x) => ceilRatio(ratio, x), (x) => ceilExact(ratio, x))).toBeUndefined();
        expect(firstMismatch(points, (x) => floorRatio(ratio, x), (x) => floorExact(ratio, x))).toBeUndefined();
      }
    },
    SWEEP_TIMEOUT_MS,
  );
});

describe('ratio-sweep tie: protocol budget functions equal their exact rational definitions', () => {
  it(
    'marginFloorFor(W) = max(ceil(W/50), MIN_MARGIN)',
    () => {
      const points = sweepPoints(1, 1);
      expect(firstMismatch(points, marginFloorFor, (W) => Number(marginOf(big(W))))).toBeUndefined();
    },
    SWEEP_TIMEOUT_MS,
  );

  it(
    'outputReserveFor = min(maxOutputTokens, max(256, ceil(W/4)), floor(W/2))',
    () => {
      const points = sweepPoints(2, 1);
      expect(firstMismatch(points, (W) => outputReserveFor(capabilitiesOf(W, W)), (W) => Number(reserveOf(big(W), big(W))))).toBeUndefined();
      expect(firstMismatch(points, (W) => outputReserveFor(capabilitiesOf(W, 1024)), (W) => Number(reserveOf(big(W), 1024n)))).toBeUndefined();
    },
    SWEEP_TIMEOUT_MS,
  );

  it(
    'summaryTokenCapFor = min(MAX, max(MIN, ceil(6W/100))), and with a room max(MIN, min(base, floor(3 room/10)))',
    () => {
      const points = sweepPoints(3, 1);
      const base = (W: number): bigint => minBig(big(MAX_SUMMARY_TOKENS), maxBig(big(MIN_SUMMARY_TOKENS), ceilBig(SUMMARY_WINDOW, big(W))));
      const withRoom = (W: number, room: number): number => Number(maxBig(big(MIN_SUMMARY_TOKENS), minBig(base(W), floorBig(SUMMARY_ROOM, big(room)))));
      expect(firstMismatch(points, (W) => summaryTokenCapFor({ contextWindow: W }), (W) => Number(base(W)))).toBeUndefined();
      expect(firstMismatch(points, (room) => summaryTokenCapFor({ contextWindow: DOMAIN }, room), (room) => withRoom(DOMAIN, room))).toBeUndefined();
      expect(firstMismatch(points, (room) => summaryTokenCapFor({ contextWindow: 65_536 }, room), (room) => withRoom(65_536, room))).toBeUndefined();
    },
    SWEEP_TIMEOUT_MS,
  );

  it(
    'summaryItemTokensFor(cap) = ceil(13 cap/10) + SUMMARY_ITEM_OVERHEAD',
    () => {
      const points = sweepPoints(4);
      expect(firstMismatch(points, summaryItemTokensFor, (cap) => Number(ceilBig(SUMMARY_ACCEPT, big(cap)) + big(SUMMARY_ITEM_OVERHEAD)))).toBeUndefined();
    },
    SWEEP_TIMEOUT_MS,
  );

  it(
    'summaryInputLimitFor = min(W - cap - headroom - marginFloor, W - outputReserve)',
    () => {
      const points = sweepPoints(5, 1);
      const expected = (W: number): number => {
        const w = big(W);
        return Number(minBig(w - 64n - 128n - marginOf(w), w - reserveOf(w, w)));
      };
      expect(firstMismatch(points, (W) => summaryInputLimitFor(capabilitiesOf(W, W), 64, 128), expected)).toBeUndefined();
    },
    SWEEP_TIMEOUT_MS,
  );
});
