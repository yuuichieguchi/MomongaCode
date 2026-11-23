import { COMPACT_AT, COMPACT_AT_PERCENT, compactAtRatioOf } from '@momonga/protocol';
import { describe, expect, it } from 'vitest';
import { proofArith } from '../support/proofs/arith.ts';
import { expectRefuted, prove } from '../support/proofs/prove.ts';
import { SOLVER_MULTI_QUERY_TEST_TIMEOUT_MS, SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS, useZ3 } from '../harness.ts';
import type { Ratio } from './budget-model.ts';
import { anyCeiling, b1Goal, b4Goal, hypothesesSatisfiable, marksOf, MAX_WINDOW, shareWithinRoomGoal, windowOf } from './budget-model.ts';

const COMPACT_AT_PERCENTS: readonly number[] = Array.from({ length: COMPACT_AT_PERCENT.max - COMPACT_AT_PERCENT.min + 1 }, (_unused, index) => COMPACT_AT_PERCENT.min + index);

describe('B1 and B4: the marks stay between the floor and the ceiling and H fits with its bound', () => {
  const z3 = useZ3();

  const marksFor = (name: string, capped: boolean, compactAt?: Ratio) => {
    const arith = proofArith(z3.engine().api, name);
    const window = windowOf(arith);
    const ceiling = anyCeiling(arith, window);
    const b = arith.errorBound('b');
    const marks = marksOf(arith, window, ceiling, b, { capped, ...(compactAt === undefined ? {} : { compactAt }) });
    return { arith, window, ceiling, b, marks };
  };

  it(
    'B1 proves F <= H <= ceiling and F <= L <= H under the baseline low mark, for every share of the room from 0 to the whole room, every W <= 2^33 and every non-decreasing b, given the floor fits',
    async () => {
      const { arith, ceiling, marks } = marksFor('B1', true);
      expect(await hypothesesSatisfiable(arith)).toBe(true);
      expect(await prove(arith, b1Goal(arith, ceiling, marks))).toEqual({ status: 'proved' });
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  it(
    'B4 proves F <= H <= ceiling and H + b(H) <= I0 with H = min(F + share, maxInputB), for every share of the room from 0 to the whole room',
    async () => {
      const { arith, window, ceiling, b, marks } = marksFor('B4', true);
      const goal = b4Goal(arith, window, ceiling, marks, b);
      expect(await hypothesesSatisfiable(arith)).toBe(true);
      expect(await prove(arith, goal)).toEqual({ status: 'proved' });
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  it(
    'B4w refutes H + b(H) <= I0 when H is F + floor(7 room/10) without the min',
    async () => {
      const { arith, window, ceiling, b, marks } = marksFor('B4w', false, COMPACT_AT);
      const goal = b4Goal(arith, window, ceiling, marks, b);
      expect(await hypothesesSatisfiable(arith)).toBe(true);
      const model = await expectRefuted(arith, goal);
      expect(Object.keys(model)).toEqual(expect.arrayContaining(['W', 'F', 'H', 'maxInputB', 'I0', 'ceiling']));
      expect(BigInt(model.H as string)).toBeGreaterThan(BigInt(model.maxInputB as string));
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  it(
    'B1s proves that the share floor(p room/100) lies between 0 and the room, for every whole p from 1 to 100 and every room <= 2^33',
    async () => {
      for (const p of COMPACT_AT_PERCENTS) {
        const arith = proofArith(z3.engine().api, `B1s-${p}`);
        const goal = shareWithinRoomGoal(arith, compactAtRatioOf(p));
        expect(await hypothesesSatisfiable(arith), `p = ${p}`).toBe(true);
        expect(await prove(arith, goal), `p = ${p}`).toEqual({ status: 'proved' });
      }
    },
    SOLVER_MULTI_QUERY_TEST_TIMEOUT_MS,
  );

  it(
    'B1s proves that the default share floor(7 room/10) is the share at p = 70, for every room <= 2^33',
    async () => {
      const arith = proofArith(z3.engine().api, 'B1s-default');
      const { ctx } = arith;
      const room = arith.int('room');
      arith.given(room.ge(0), room.le(ctx.Int.val(MAX_WINDOW)));
      const recordedDefault: Ratio = { num: 7, den: 10 };
      const atSeventyPercent = compactAtRatioOf(70);
      const atDefault = arith.floorDiv(room.mul(ctx.Int.val(BigInt(recordedDefault.num))), BigInt(recordedDefault.den));
      const atSeventy = arith.floorDiv(room.mul(ctx.Int.val(BigInt(atSeventyPercent.num))), BigInt(atSeventyPercent.den));
      expect(await hypothesesSatisfiable(arith)).toBe(true);
      expect(await prove(arith, atDefault.eq(atSeventy))).toEqual({ status: 'proved' });
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );
});
