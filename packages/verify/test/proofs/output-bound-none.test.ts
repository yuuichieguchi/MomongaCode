import { describe, expect, it } from 'vitest';
import { budgetFor } from '@momonga/context';
import { MARGIN, MIN_MARGIN, OUTPUT_RESERVE, ceilRatio, marginFloorFor } from '@momonga/protocol';
import type { Capabilities } from '@momonga/protocol';
import { proofArith } from '../support/proofs/arith.ts';
import type { ProofArith, ProofBool } from '../support/proofs/arith.ts';
import { expectRefuted, prove } from '../support/proofs/prove.ts';
import { SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS, useZ3 } from '../harness.ts';
import { chainWindowOf, ceilOf, hypothesesSatisfiable, named, unboundedWindowOf, windowOf } from './budget-model.ts';
import type { ChainWindow } from './budget-model.ts';

const everyMemberFits = (arith: ProofArith, window: ChainWindow): ProofBool => {
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

describe('design-chatgpt-plan.md P2 item 6 and I-K5: the context budget of a chain that has a member without an output bound', () => {
  const z3 = useZ3();

  it(
    'N1 proves, for a chain of three members and under the load-time rule, I + R + margin <= W and I >= ceil(W / 4) with W the smallest window and R the largest declared maximum, and input + output <= W - margin for the output of whichever member serves the request',
    async () => {
      const arith = proofArith(z3.engine().api, 'N1');
      const window = chainWindowOf(arith, { loadRule: true });
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
      const window = chainWindowOf(arith, { loadRule: false });
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
      const window = chainWindowOf(arith, { loadRule: false });
      expect(await hypothesesSatisfiable(arith)).toBe(true);
      await expectRefuted(arith, window.I0.ge(ceilOf(arith, OUTPUT_RESERVE, window.W)));
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  it(
    'N1y refutes the output fit of the member with the smallest window when R is the maximum of that member alone, not of the chain',
    async () => {
      const arith = proofArith(z3.engine().api, 'N1y');
      const window = chainWindowOf(arith, { loadRule: true });
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
    'N3 proves the rule implies R < W for the chain, so no member can emit more than the smallest window',
    async () => {
      const arith = proofArith(z3.engine().api, 'N3');
      const window = chainWindowOf(arith, { loadRule: true });
      expect(await hypothesesSatisfiable(arith)).toBe(true);
      expect(await prove(arith, window.R.lt(window.W))).toEqual({ status: 'proved' });
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  it(
    'N4 proves, for one target whose outputBoundField is none and under the load-time rule, that R = maxOutputTokens and input + output <= W - margin for every output the route may emit',
    async () => {
      const arith = proofArith(z3.engine().api, 'N4');
      const window = unboundedWindowOf(arith, { loadRule: true });
      const output = arith.int('output');
      arith.given(output.ge(0), output.le(window.maxOutput));
      expect(await hypothesesSatisfiable(arith)).toBe(true);
      const goal = arith.ctx.And(window.I0.add(window.R).add(window.margin).le(window.W), window.I0.add(output).add(window.margin).le(window.W));
      expect(await prove(arith, goal)).toEqual({ status: 'proved' });
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  it(
    'N4w refutes the output fit of a none target when R is the bounded reserve instead of maxOutputTokens',
    async () => {
      const arith = proofArith(z3.engine().api, 'N4w');
      const bounded = windowOf(arith);
      const output = arith.int('output');
      arith.given(output.ge(0), output.le(bounded.maxOutput));
      expect(await hypothesesSatisfiable(arith)).toBe(true);
      await expectRefuted(arith, bounded.I0.add(output).add(bounded.margin).le(bounded.W));
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );
});

describe('budgetFor computes the none branch the model states (drift)', () => {
  const BASE: Capabilities = {
    contextWindow: 1,
    maxOutputTokens: 1,
    toolCalling: 'native',
    structuredOutput: 'json_schema',
    streaming: true,
    stopSequences: true,
    imageInput: false,
    schemaDialect: 'json-schema-2020-12',
    tokenCounting: 'exact',
    usageReported: true,
    maxConcurrency: 1,
    source: 'declared',
  };
  const modelMargin = (window: number): number => Math.max(ceilRatio(MARGIN, window), MIN_MARGIN);
  const SAMPLES: ReadonlyArray<{ window: number; maxOutput: number; unbounded?: number }> = [
    { window: 8192, maxOutput: 4096 },
    { window: 8192, maxOutput: 4096, unbounded: 6000 },
    { window: 128_000, maxOutput: 32_000 },
    { window: 200_000, maxOutput: 64_000, unbounded: 100_000 },
    { window: 1000, maxOutput: 1000 },
  ];

  it.each(SAMPLES)('reserves the unbounded output and keeps the model margin for %o', ({ window, maxOutput, unbounded }) => {
    const capabilities = { ...BASE, contextWindow: window, maxOutputTokens: maxOutput, outputBoundField: 'none' as const, ...(unbounded === undefined ? {} : { unboundedOutputTokens: unbounded }) };
    const R = unbounded ?? maxOutput;
    expect(marginFloorFor(window)).toBe(modelMargin(window));
    expect(budgetFor(capabilities, 0, 0)).toEqual({ W: window, R, margin: modelMargin(window), I: Math.max(0, window - R - modelMargin(window)) });
  });
});
