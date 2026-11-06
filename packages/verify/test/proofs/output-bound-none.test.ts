import { describe, expect, it } from 'vitest';
import { OUTPUT_RESERVE } from '@momonga/protocol';
import { proofArith } from '../../src/proofs/arith.ts';
import type { ProofArith, ProofBool } from '../../src/proofs/arith.ts';
import { expectRefuted, prove } from '../../src/proofs/prove.ts';
import { SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS, useZ3 } from '../harness.ts';
import { aliasWindowOf, ceilOf, hypothesesSatisfiable, named, windowOf } from './budget-model.ts';
import type { AliasWindow } from './budget-model.ts';

const everyMemberFits = (arith: ProofArith, window: AliasWindow): ProofBool => {
  const outputs = window.members.map((member, index) => {
    const output = arith.int(`out${index}`);
    arith.given(output.ge(0), output.le(member.maxOutput));
    return arith.ctx.And(
      window.I0.add(output).add(window.margin).le(window.W),
      window.I0.add(output).add(window.margin).le(member.window),
    );
  });
  return arith.ctx.And(...outputs);
};

describe('design-chatgpt-plan.md P2 item 6 and I-K5: the context budget of an alias that has a member without an output bound', () => {
  const z3 = useZ3();

  it(
    'N1 proves, for an alias of three members and under the load-time rule, I + R + margin <= W and I >= ceil(W / 4) with W the smallest window and R the largest declared maximum, and input + output <= W - margin for the output of whichever member serves the request',
    async () => {
      const arith = proofArith(z3.engine().api, 'N1');
      const window = aliasWindowOf(arith, { loadRule: true });
      const fits = everyMemberFits(arith, window);
      expect(await hypothesesSatisfiable(arith)).toBe(true);
      const goal = arith.ctx.And(
        window.I0.add(window.R).add(window.margin).le(window.W),
        window.I0.ge(ceilOf(arith, OUTPUT_RESERVE, window.W)),
        fits,
      );
      expect(await prove(arith, goal)).toEqual({ status: 'proved' });
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  it(
    'N1w refutes I + R + margin <= W without the load-time rule: a member whose maximum exceeds the smallest window clamps the input room at 0',
    async () => {
      const arith = proofArith(z3.engine().api, 'N1w');
      const window = aliasWindowOf(arith, { loadRule: false });
      expect(await hypothesesSatisfiable(arith)).toBe(true);
      const model = await expectRefuted(arith, window.I0.add(window.R).add(window.margin).le(window.W));
      expect(model.I0).toBe('0');
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  it(
    'N1x refutes I >= ceil(W / 4) without the load-time rule',
    async () => {
      const arith = proofArith(z3.engine().api, 'N1x');
      const window = aliasWindowOf(arith, { loadRule: false });
      expect(await hypothesesSatisfiable(arith)).toBe(true);
      await expectRefuted(arith, window.I0.ge(ceilOf(arith, OUTPUT_RESERVE, window.W)));
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  it(
    'N1y refutes the output fit of the member with the smallest window when R is the maximum of that member alone, not of the alias',
    async () => {
      const arith = proofArith(z3.engine().api, 'N1y');
      const window = aliasWindowOf(arith, { loadRule: true });
      const firstOutput = window.members[0]!.maxOutput;
      const secondOutput = window.members[1]!.maxOutput;
      const own = arith.int('ownBudget');
      arith.given(own.eq(arith.max(arith.ctx.Int.val(0n), window.W.sub(firstOutput).sub(window.margin))), secondOutput.gt(firstOutput));
      expect(await hypothesesSatisfiable(arith)).toBe(true);
      await expectRefuted(arith, own.add(secondOutput).add(window.margin).le(window.W));
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
    'N3 proves the rule implies R < W for the alias, so no member can emit more than the smallest window',
    async () => {
      const arith = proofArith(z3.engine().api, 'N3');
      const window = aliasWindowOf(arith, { loadRule: true });
      expect(await hypothesesSatisfiable(arith)).toBe(true);
      expect(await prove(arith, window.R.lt(window.W))).toEqual({ status: 'proved' });
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );
});
