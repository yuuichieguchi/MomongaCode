import { describe, expect, it } from 'vitest';
import { MIN_RATE_POPULATION } from '@momonga/protocol';
import { wilsonInterval } from '@momonga/reliability';
import { proofArith } from '../support/proofs/arith.ts';
import type { ProofArith } from '../support/proofs/arith.ts';
import { expectRefuted, prove } from '../support/proofs/prove.ts';
import { SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS, useZ3 } from '../harness.ts';

const Z_95 = '1.959963984540054';
const ZERO_FAILURE_HEADLINE_BOUND = '0.1';
const ZERO_MISS_REVIEW_BOUND = '0.05';
const DESIGN_REVIEW_SAMPLE_SIZE = 73;
const SWEPT_POPULATION = 400;
const FLOAT_SLACK = 1e-12;

const zeroFailureHigh = (n: number): number => wilsonInterval(0, n).high;

const leastPopulationBelow = (bound: number): number => {
  for (let n = 1; n <= SWEPT_POPULATION; n += 1) if (zeroFailureHigh(n) <= bound) return n;
  throw new Error(`no population up to ${SWEPT_POPULATION} bounds a zero-failure rate at ${bound}`);
};

describe('the populations of the reliability report', () => {
  const z3 = useZ3();

  const zeroFailureAt = (arith: ProofArith, population: ReturnType<ProofArith['int']>) => {
    const { ctx } = arith;
    const z2 = ctx.Real.val(Z_95).mul(ctx.Real.val(Z_95));
    const high = z2.div(ctx.ToReal(population).add(z2));
    return { z2, high };
  };

  it('computes the same zero-failure upper bound in the code as in the proofs: z^2 / (n + z^2)', () => {
    const z2 = Number(Z_95) ** 2;
    for (let n = 1; n <= SWEPT_POPULATION; n += 1) expect(Math.abs(zeroFailureHigh(n) - z2 / (n + z2))).toBeLessThan(FLOAT_SLACK);
  });

  it(
    'W1 proves a zero-failure upper bound of at most 10% for every population of at least MIN_RATE_POPULATION',
    async () => {
      const arith = proofArith(z3.engine().api, 'W1');
      const population = arith.int('n');
      arith.given(population.ge(MIN_RATE_POPULATION));
      const { high } = zeroFailureAt(arith, population);
      expect(await prove(arith, high.le(arith.ctx.Real.val(ZERO_FAILURE_HEADLINE_BOUND)))).toEqual({ status: 'proved' });
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  it(
    'W2 proves that no smaller population bounds it at 10%, so MIN_RATE_POPULATION is the least',
    async () => {
      const arith = proofArith(z3.engine().api, 'W2');
      const population = arith.int('n');
      arith.given(population.ge(1), population.lt(MIN_RATE_POPULATION));
      const { high } = zeroFailureAt(arith, population);
      expect(await prove(arith, high.gt(arith.ctx.Real.val(ZERO_FAILURE_HEADLINE_BOUND)))).toEqual({ status: 'proved' });
      expect(leastPopulationBelow(Number(ZERO_FAILURE_HEADLINE_BOUND))).toBe(MIN_RATE_POPULATION);
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  it(
    'W2w refutes the bound for one population fewer than MIN_RATE_POPULATION',
    async () => {
      const arith = proofArith(z3.engine().api, 'W2w');
      const population = arith.int('n');
      arith.given(population.ge(MIN_RATE_POPULATION - 1));
      const { high } = zeroFailureAt(arith, population);
      const model = await expectRefuted(arith, high.le(arith.ctx.Real.val(ZERO_FAILURE_HEADLINE_BOUND)));
      expect(Number(model.n)).toBe(MIN_RATE_POPULATION - 1);
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  it(
    'W3 proves that the review sample of the design is the least population that bounds a zero-miss rate at 5%',
    async () => {
      const atLeast = proofArith(z3.engine().api, 'W3a');
      const sample = atLeast.int('n');
      atLeast.given(sample.ge(DESIGN_REVIEW_SAMPLE_SIZE));
      expect(await prove(atLeast, zeroFailureAt(atLeast, sample).high.le(atLeast.ctx.Real.val(ZERO_MISS_REVIEW_BOUND)))).toEqual({ status: 'proved' });
      const below = proofArith(z3.engine().api, 'W3b');
      const fewer = below.int('n');
      below.given(fewer.ge(1), fewer.lt(DESIGN_REVIEW_SAMPLE_SIZE));
      expect(await prove(below, zeroFailureAt(below, fewer).high.gt(below.ctx.Real.val(ZERO_MISS_REVIEW_BOUND)))).toEqual({ status: 'proved' });
      expect(leastPopulationBelow(Number(ZERO_MISS_REVIEW_BOUND))).toBe(DESIGN_REVIEW_SAMPLE_SIZE);
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  describe('the Wilson interval, in terms of p = k / n and h = z^2 / (2n), for every real p in [0, 1] and h > 0', () => {
    const frame = (name: string) => {
      const arith = proofArith(z3.engine().api, name);
      const { ctx } = arith;
      const p = ctx.Real.const('p');
      const h = ctx.Real.const('h');
      const margin = ctx.Real.const('margin');
      const one = ctx.Real.val(1);
      const two = ctx.Real.val(2);
      const center = p.add(h);
      const denominator = one.add(two.mul(h));
      arith.given(p.ge(0), p.le(1), h.gt(0), margin.ge(0), margin.mul(margin).eq(two.mul(h).mul(p).mul(one.sub(p)).add(h.mul(h))));
      return { arith, p, margin, center, denominator, one };
    };

    it(
      'W4 proves 0 <= low: the margin never exceeds the center, so the clamp at 0 only absorbs rounding',
      async () => {
        const { arith, margin, center } = frame('W4');
        expect(await prove(arith, margin.le(center))).toEqual({ status: 'proved' });
      },
      SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
    );

    it(
      'W5 proves high <= 1, so the clamp at 1 only absorbs rounding',
      async () => {
        const { arith, margin, center, denominator } = frame('W5');
        expect(await prove(arith, center.add(margin).le(denominator))).toEqual({ status: 'proved' });
      },
      SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
    );

    it(
      'W6 proves low <= p <= high: the printed rate lies inside its own interval',
      async () => {
        const { arith, p, margin, center, denominator } = frame('W6');
        const inside = arith.ctx.And(center.sub(margin).le(p.mul(denominator)), p.mul(denominator).le(center.add(margin)));
        expect(await prove(arith, inside)).toEqual({ status: 'proved' });
      },
      SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
    );

    it(
      'W6w refutes it when the margin is too small: a margin of half the true one leaves p outside',
      async () => {
        const { arith, p, margin, center, denominator } = frame('W6w');
        const outside = arith.ctx.And(center.sub(margin.div(2)).le(p.mul(denominator)), p.mul(denominator).le(center.add(margin.div(2))));
        await expectRefuted(arith, outside);
      },
      SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
    );

    it('computes the interval of the code from the same p, h and margin', () => {
      for (let n = 1; n <= 60; n += 1) {
        for (let k = 0; k <= n; k += 1) {
          const p = k / n;
          const h = Number(Z_95) ** 2 / (2 * n);
          const margin = Math.sqrt(2 * h * p * (1 - p) + h * h);
          const denominator = 1 + 2 * h;
          const interval = wilsonInterval(k, n);
          expect(Math.abs(interval.low - Math.max(0, (p + h - margin) / denominator))).toBeLessThan(FLOAT_SLACK);
          expect(Math.abs(interval.high - Math.min(1, (p + h + margin) / denominator))).toBeLessThan(FLOAT_SLACK);
        }
      }
    });
  });
});
