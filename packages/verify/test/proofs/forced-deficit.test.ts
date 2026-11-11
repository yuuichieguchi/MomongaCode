import { describe, expect, it } from 'vitest';
import { MARGIN_RATIO, MIN_MARGIN } from '@momonga/protocol';
import { proofArith } from '../support/proofs/arith.ts';
import type { ProofArith } from '../support/proofs/arith.ts';
import { prove } from '../support/proofs/prove.ts';
import { SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS, useZ3 } from '../harness.ts';

const MAX_WINDOW = 2n ** 33n;

const forcedCompaction = (arith: ProofArith, withMonotonicity: boolean) => {
  const { ctx } = arith;
  const W = arith.int('W');
  const maxOutput = arith.int('maxOutput');
  const R = arith.int('R');
  const ceiling = arith.int('ceiling');
  const maxInput = arith.int('maxInput');
  const total = arith.int('total');
  const region = arith.int('region');
  const item = arith.int('item');
  const b = arith.errorBound('b');

  arith.given(W.ge(1), W.le(ctx.Int.val(MAX_WINDOW)), maxOutput.ge(1), maxOutput.le(W), R.ge(0), R.le(maxOutput));
  const margin = arith.max(arith.ceilRatio(MARGIN_RATIO, W), ctx.Int.val(MIN_MARGIN));
  const inputBudget = arith.max(ctx.Int.val(0), W.sub(R).sub(margin));
  arith.given(ceiling.ge(0), ceiling.le(inputBudget));
  arith.given(maxInput.ge(0), maxInput.le(ceiling), maxInput.add(b.at(maxInput)).le(inputBudget));
  const deficit = total.sub(maxInput);
  arith.given(total.ge(0), region.ge(0), region.le(total), item.ge(0));
  arith.given(region.sub(item).ge(deficit));
  const after = total.sub(region).add(item);
  if (withMonotonicity) b.monotone(after, maxInput);
  return { goal: after.add(b.at(after)).le(inputBudget) };
};

describe('B3: an accepted forced compaction fits the input budget with its error bound', () => {
  const z3 = useZ3();

  it(
    'proves total + b(total) <= I0 after the compaction for every window, output reserve, error ratio and minimum',
    async () => {
      const arith = proofArith(z3.engine().api, 'B3');
      const { goal } = forcedCompaction(arith, true);
      expect(await prove(arith, goal)).toEqual({ status: 'proved' });
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  it(
    'is refuted with a model when the error bound is not known to be non-decreasing',
    async () => {
      const arith = proofArith(z3.engine().api, 'B3-without-monotonicity');
      const { goal } = forcedCompaction(arith, false);
      const result = await prove(arith, goal);
      expect(result.status).toBe('refuted');
      if (result.status !== 'refuted') return;
      expect(Object.keys(result.model)).toEqual(expect.arrayContaining(['W', 'maxInput', 'total', 'region', 'item']));
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );
});
