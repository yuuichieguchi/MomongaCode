import { describe, expect, it } from 'vitest';
import { OUTPUT_RESERVE } from '@momonga/protocol';
import { proofArith } from '../../src/proofs/arith.ts';
import { expectRefuted, prove } from '../../src/proofs/prove.ts';
import { SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS, useZ3 } from '../harness.ts';
import { ceilOf, hypothesesSatisfiable, named, unboundedWindowOf, windowOf } from './budget-model.ts';

describe('design-chatgpt-plan.md P2 item 6: the context budget of a target that carries no output bound', () => {
  const z3 = useZ3();

  it(
    'N1 proves, under the load-time rule, I + R + margin <= W and I >= ceil(W / 4) with R the largest declared maximum, so input + output <= W - margin for every output up to that maximum',
    async () => {
      const arith = proofArith(z3.engine().api, 'N1');
      const window = unboundedWindowOf(arith, { loadRule: true });
      const output = arith.int('output');
      arith.given(output.ge(0), output.le(window.R));
      expect(await hypothesesSatisfiable(arith)).toBe(true);
      const { ctx } = arith;
      const goal = ctx.And(
        window.I0.add(window.R).add(window.margin).le(window.W),
        window.I0.ge(ceilOf(arith, OUTPUT_RESERVE, window.W)),
        window.I0.add(output).add(window.margin).le(window.W),
      );
      expect(await prove(arith, goal)).toEqual({ status: 'proved' });
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  it(
    'N1w refutes I + R + margin <= W without the load-time rule: the input room clamps at 0 once the maximum and the margin exceed the window',
    async () => {
      const arith = proofArith(z3.engine().api, 'N1w');
      const window = unboundedWindowOf(arith, { loadRule: false });
      expect(await hypothesesSatisfiable(arith)).toBe(true);
      const model = await expectRefuted(arith, window.I0.add(window.R).add(window.margin).le(window.W));
      expect(model.I0).toBe('0');
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  it(
    'N1x refutes I >= ceil(W / 4) without the load-time rule even when the sum fits',
    async () => {
      const arith = proofArith(z3.engine().api, 'N1x');
      const window = unboundedWindowOf(arith, { loadRule: false });
      expect(await hypothesesSatisfiable(arith)).toBe(true);
      await expectRefuted(arith, window.I0.ge(ceilOf(arith, OUTPUT_RESERVE, window.W)));
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  it(
    'N2 proves the input room a target without a bound gives up is exactly maxOutputTokens - R, the reserve a bounded target keeps, under the same rule',
    async () => {
      const arith = proofArith(z3.engine().api, 'N2');
      const bounded = windowOf(arith);
      const unbounded = named(arith, 'I0none', arith.max(arith.ctx.Int.val(0), bounded.W.sub(bounded.maxOutput).sub(bounded.margin)));
      arith.given(bounded.W.sub(bounded.maxOutput).sub(bounded.margin).ge(ceilOf(arith, OUTPUT_RESERVE, bounded.W)));
      expect(await hypothesesSatisfiable(arith)).toBe(true);
      expect(await prove(arith, bounded.I0.sub(unbounded).eq(bounded.maxOutput.sub(bounded.R)))).toEqual({ status: 'proved' });
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  it(
    'N3 proves a merged window below the largest member maximum is refused by the rule: the rule implies U < W',
    async () => {
      const arith = proofArith(z3.engine().api, 'N3');
      const window = unboundedWindowOf(arith, { loadRule: true });
      expect(await hypothesesSatisfiable(arith)).toBe(true);
      expect(await prove(arith, window.R.lt(window.W))).toEqual({ status: 'proved' });
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );
});
