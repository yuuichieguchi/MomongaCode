import { describe, expect, it } from 'vitest';
import { proofArith } from '../support/proofs/arith.ts';
import type { ProofArith, ProofInt } from '../support/proofs/arith.ts';
import { prove } from '../support/proofs/prove.ts';
import { SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS, useZ3 } from '../harness.ts';

const roundedPercentOf = (arith: ProofArith, tokens: ProofInt, window: ProofInt, label: string): ProofInt => {
  const quotient = arith.int(label);
  const numerator = tokens.mul(200).add(window);
  const divisor = window.mul(2);
  arith.given(quotient.mul(divisor).le(numerator), quotient.add(1).mul(divisor).gt(numerator));
  return quotient;
};

describe('footer percent (design/cli-tui.md sections 3.2 and 15.4): round(100 tokens / window), with the code of packages/cli/src/tui/screen/footer.tsx checked by test/screen-proofs-drift.test.ts', () => {
  const z3 = useZ3();

  it(
    'is 0 exactly when tokens x 200 < window, is 0 for 0 tokens, and is monotone in tokens',
    async () => {
      const arith = proofArith(z3.engine().api, 'footer-percent');
      const { ctx } = arith;
      const window = arith.int('window');
      const tokens = arith.int('tokens');
      const more = arith.int('more');
      arith.given(window.ge(1), tokens.ge(0), more.ge(tokens));
      const percent = roundedPercentOf(arith, tokens, window, 'percent');
      const morePercent = roundedPercentOf(arith, more, window, 'morePercent');
      const zeroPercent = roundedPercentOf(arith, ctx.Int.val(0), window, 'zeroPercent');
      const goal = ctx.And(percent.eq(0).eq(tokens.mul(200).lt(window)), zeroPercent.eq(0), percent.le(morePercent));
      expect(await prove(arith, goal)).toEqual({ status: 'proved' });
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );
});
