import { describe, expect, it } from 'vitest';
import { ATTACH_FILE_SHARE, ATTACH_MAX_FILES, ATTACH_TOTAL_SHARE, admits, attachLimitsFor } from '@momonga/context';
import { proofArith } from '../support/proofs/arith.ts';
import type { ProofArith, ProofBool, ProofInt } from '../support/proofs/arith.ts';
import { prove } from '../support/proofs/prove.ts';
import { SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS, useZ3 } from '../harness.ts';
import { floorOf } from './budget-model.ts';

type Limits = { readonly perFile: ProofInt; readonly total: ProofInt };

const limitsOf = (arith: ProofArith, ceiling: ProofInt): Limits => ({ perFile: floorOf(arith, ATTACH_FILE_SHARE, ceiling), total: floorOf(arith, ATTACH_TOTAL_SHARE, ceiling) });

const admitsOf = (arith: ProofArith, limits: Limits, admitted: ProofInt, estimate: ProofInt): ProofBool => arith.ctx.And(estimate.le(limits.perFile), admitted.add(estimate).le(limits.total));

describe('attach share (design/cli-tui.md sections 5.8 and 15.4): the admission rule of packages/context/src/attachments.ts', () => {
  const z3 = useZ3();

  it('reads attachLimitsFor and admits of the product at sampled ceilings and estimates', () => {
    for (const ceiling of [0, 1, 9, 10, 39, 40, 41, 128_000, 1_000_003]) {
      const limits = attachLimitsFor(ceiling);
      expect([limits.perFile, limits.total, limits.maxFiles]).toEqual([Math.floor((ceiling * ATTACH_FILE_SHARE.num) / ATTACH_FILE_SHARE.den), Math.floor((ceiling * ATTACH_TOTAL_SHARE.num) / ATTACH_TOTAL_SHARE.den), ATTACH_MAX_FILES]);
      for (const admitted of [0, Math.floor(limits.total / 2), limits.total]) {
        for (const estimate of [0, 1, limits.perFile, limits.perFile + 1, limits.total - admitted, limits.total - admitted + 1]) {
          expect(admits(limits, admitted, estimate)).toBe(estimate <= limits.perFile && admitted + estimate <= limits.total);
        }
      }
    }
  });

  it(
    'admits, for every ceiling and in any order of at most ATTACH_MAX_FILES estimates, a set within the total share whose every file is within the per-file share',
    async () => {
      const arith = proofArith(z3.engine().api, 'attach-share-step');
      const { ctx } = arith;
      const ceiling = arith.int('C');
      const admitted = arith.int('admitted');
      const files = arith.int('files');
      const estimate = arith.int('estimate');
      arith.given(ceiling.ge(0), estimate.ge(0), admitted.ge(0), files.ge(0));
      const limits = limitsOf(arith, ceiling);
      arith.given(admitted.le(limits.total), files.le(ATTACH_MAX_FILES));
      const taken = ctx.And(files.lt(ATTACH_MAX_FILES), admitsOf(arith, limits, admitted, estimate));
      const nextAdmitted = ctx.If(taken, admitted.add(estimate), admitted) as ProofInt;
      const nextFiles = ctx.If(taken, files.add(1), files) as ProofInt;
      const goal = ctx.And(nextAdmitted.le(limits.total), nextFiles.le(ATTACH_MAX_FILES), ctx.Implies(taken, estimate.le(limits.perFile)), limits.perFile.le(limits.total));
      expect(await prove(arith, goal)).toEqual({ status: 'proved' });
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  it(
    'refuses for every larger estimate a file it refuses for size',
    async () => {
      const arith = proofArith(z3.engine().api, 'attach-share-monotone');
      const { ctx } = arith;
      const ceiling = arith.int('C');
      const admitted = arith.int('admitted');
      const estimate = arith.int('estimate');
      const larger = arith.int('larger');
      arith.given(ceiling.ge(0), admitted.ge(0), estimate.ge(0), larger.ge(estimate));
      const limits = limitsOf(arith, ceiling);
      const goal = ctx.Implies(ctx.Not(admitsOf(arith, limits, admitted, estimate)), ctx.Not(admitsOf(arith, limits, admitted, larger)));
      expect(await prove(arith, goal)).toEqual({ status: 'proved' });
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );
});
