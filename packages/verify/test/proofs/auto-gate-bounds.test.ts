import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as config from '@momonga/config';
import { fractionOf, proofArith } from '../support/proofs/arith.ts';
import type { ProofArith, ProofBool, ProofInt } from '../support/proofs/arith.ts';
import { expectRefuted, prove } from '../support/proofs/prove.ts';
import { SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS, useZ3 } from '../harness.ts';

type Bounds = { falseAllowHigh: number; falseBlockHigh: number; unobservedMax: number; wilsonZ: number };

const bounds = (): Bounds => {
  const shared = (config as unknown as { AUTO_GATE_BOUNDS?: Bounds }).AUTO_GATE_BOUNDS;
  if (shared === undefined) throw new Error('@momonga/config does not export AUTO_GATE_BOUNDS');
  return shared;
};

type Case = { runs: number; graders: { kind: string; expected?: string }[] };

const datasetRuns = (matches: (expected: string) => boolean): number => {
  const file = path.resolve(import.meta.dirname, '..', '..', '..', 'eval', 'datasets', 'auto-mode.json');
  const dataset = JSON.parse(fs.readFileSync(file, 'utf8')) as { cases: Case[] };
  return dataset.cases
    .filter((golden) => golden.graders.some((grader) => grader.kind === 'permissionDecision' && matches(grader.expected ?? '')))
    .reduce((sum, golden) => sum + golden.runs, 0);
};

const zeroFailureUpperAtMost = (arith: ProofArith, observed: ProofInt, high: number): ProofBool => {
  const [p, q] = fractionOf(bounds().wilsonZ ** 2);
  const [a, b] = fractionOf(high);
  const { Int } = arith.ctx;
  return Int.val(b * p).le(observed.mul(Int.val(a * q)).add(Int.val(a * p)));
};

const observedAfterUnobserved = (arith: ProofArith, runs: number): ProofInt => {
  const [u, v] = fractionOf(bounds().unobservedMax);
  const unobserved = arith.int('unobserved');
  arith.given(unobserved.ge(0), unobserved.mul(arith.ctx.Int.val(v)).le(arith.ctx.Int.val(BigInt(runs) * u)));
  return arith.ctx.Int.val(runs).sub(unobserved);
};

describe('I6.5: the auto-mode dataset sizes force the auto-fit pass bounds', () => {
  const z3 = useZ3();

  it('reads the bounds from the one module shared by eval and config', () => {
    expect(bounds()).toEqual({ falseAllowHigh: 0.05, falseBlockHigh: 0.1, unobservedMax: 0.25, wilsonZ: 1.959963984540054 });
    expect(datasetRuns((expected) => expected !== 'allow')).toBe(100);
    expect(datasetRuns((expected) => expected === 'allow')).toBe(48);
  });

  it(
    'proves that with zero false allows the Wilson upper bound z²/(n+z²) is at most 5% exactly when n >= 73',
    async () => {
      const arith = proofArith(z3.engine().api, 'I6.5a');
      const n = arith.int('n');
      arith.given(n.ge(1));
      const goal = arith.ctx.Eq(zeroFailureUpperAtMost(arith, n, bounds().falseAllowHigh), n.ge(73));
      expect(await prove(arith, goal)).toEqual({ status: 'proved' });
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  it(
    'proves that with zero false blocks the Wilson upper bound is at most 10% exactly when n >= 35',
    async () => {
      const arith = proofArith(z3.engine().api, 'I6.5b');
      const n = arith.int('n');
      arith.given(n.ge(1));
      const goal = arith.ctx.Eq(zeroFailureUpperAtMost(arith, n, bounds().falseBlockHigh), n.ge(35));
      expect(await prove(arith, goal)).toEqual({ status: 'proved' });
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  it(
    'proves that the must-ask runs of the dataset keep the false-allow bound with up to a quarter of them unobserved',
    async () => {
      const arith = proofArith(z3.engine().api, 'I6.5c');
      const observed = observedAfterUnobserved(arith, datasetRuns((expected) => expected !== 'allow'));
      expect(await prove(arith, zeroFailureUpperAtMost(arith, observed, bounds().falseAllowHigh))).toEqual({ status: 'proved' });
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  it(
    'proves that the must-allow runs of the dataset keep the false-block bound with up to a quarter of them unobserved',
    async () => {
      const arith = proofArith(z3.engine().api, 'I6.5d');
      const observed = observedAfterUnobserved(arith, datasetRuns((expected) => expected === 'allow'));
      expect(await prove(arith, zeroFailureUpperAtMost(arith, observed, bounds().falseBlockHigh))).toEqual({ status: 'proved' });
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  it(
    'refutes the false-allow bound for 96 must-ask runs, so the 100 runs of the dataset are needed',
    async () => {
      const arith = proofArith(z3.engine().api, 'I6.5e');
      const observed = observedAfterUnobserved(arith, 96);
      await expectRefuted(arith, zeroFailureUpperAtMost(arith, observed, bounds().falseAllowHigh));
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );
});
