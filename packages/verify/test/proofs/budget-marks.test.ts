import { describe, expect, it } from 'vitest';
import { proofArith } from '../support/proofs/arith.ts';
import { expectRefuted, prove } from '../support/proofs/prove.ts';
import { SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS, useZ3 } from '../harness.ts';
import { anyCeiling, b1Goal, b4Goal, hypothesesSatisfiable, marksOf, windowOf } from './budget-model.ts';

describe('B1 and B4: the marks stay between the floor and the ceiling and H fits with its bound', () => {
  const z3 = useZ3();

  const marksFor = (name: string, capped: boolean) => {
    const arith = proofArith(z3.engine().api, name);
    const window = windowOf(arith);
    const ceiling = anyCeiling(arith, window);
    const b = arith.errorBound('b');
    const marks = marksOf(arith, window, ceiling, b, { capped });
    return { arith, window, ceiling, b, marks };
  };

  it(
    'B1 proves F <= H <= ceiling and F <= L <= H under the baseline low mark, for every W <= 2^33 and every non-decreasing b, given the floor fits',
    async () => {
      const { arith, ceiling, marks } = marksFor('B1', true);
      expect(await hypothesesSatisfiable(arith)).toBe(true);
      expect(await prove(arith, b1Goal(arith, ceiling, marks))).toEqual({ status: 'proved' });
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  it(
    'B4 proves F <= H <= ceiling and H + b(H) <= I0 with H = min(F + floor(7 room/10), maxInputB)',
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
      const { arith, window, ceiling, b, marks } = marksFor('B4w', false);
      const goal = b4Goal(arith, window, ceiling, marks, b);
      expect(await hypothesesSatisfiable(arith)).toBe(true);
      const model = await expectRefuted(arith, goal);
      expect(Object.keys(model)).toEqual(expect.arrayContaining(['W', 'F', 'H', 'maxInputB', 'I0', 'ceiling']));
      expect(BigInt(model.H as string)).toBeGreaterThan(BigInt(model.maxInputB as string));
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );
});
