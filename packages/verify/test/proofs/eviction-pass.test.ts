import { describe, expect, it } from 'vitest';
import { proofArith } from '../support/proofs/arith.ts';
import type { ErrorBound, ProofArith, ProofInt } from '../support/proofs/arith.ts';
import { expectRefuted, prove } from '../support/proofs/prove.ts';
import { SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS, useZ3 } from '../harness.ts';

const shapeOf = (arith: ProofArith, name: string): ErrorBound => {
  const sigma = arith.errorBound(name);
  arith.given(sigma.at(arith.ctx.Int.val(0)).eq(0));
  return sigma;
};

type Split = { readonly known: ProofInt; readonly restA: ProofInt; readonly fixedA: ProofInt };

const loadAt = (split: Split, sigmaB: ErrorBound, excess: ErrorBound, restB: ProofInt): ProofInt =>
  split.known.add(restB).add(split.fixedA).add(sigmaB.at(restB)).add(excess.at(split.restA.add(restB)));

const movedSplit = (arith: ProofArith, sigmaA: ErrorBound, prefix: string): Split => {
  const kept = arith.int(`${prefix}kept`);
  const restA = arith.int(`${prefix}restA`);
  arith.given(kept.ge(0), restA.ge(0), restA.le(kept));
  return { known: kept.sub(restA), restA, fixedA: sigmaA.at(restA) };
};

describe('B11: behind the moved j, every further member of an oldest-first pass lowers the load', () => {
  const z3 = useZ3();

  it(
    'proves load(rest(b, j) - s) <= load(rest(b, j)) for every split, error shapes and saving s >= 1, so the longest oldest-first pass has the lowest load',
    async () => {
      const arith = proofArith(z3.engine().api, 'B11');
      const sigmaA = shapeOf(arith, 'sigmaA');
      const sigmaB = shapeOf(arith, 'sigmaB');
      const excess = shapeOf(arith, 'excess');
      const split = movedSplit(arith, sigmaA, '');
      const restB = arith.int('restB');
      const saving = arith.int('saving');
      arith.given(restB.ge(0), saving.ge(1), saving.le(restB));
      const shorter = restB.sub(saving);
      sigmaB.monotone(shorter, restB);
      excess.monotone(split.restA.add(shorter), split.restA.add(restB));
      expect(await prove(arith, loadAt(split, sigmaB, excess, shorter).le(loadAt(split, sigmaB, excess, restB)))).toEqual({ status: 'proved' });
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  it(
    'is refuted with a model when the error shapes are not known to be non-decreasing',
    async () => {
      const arith = proofArith(z3.engine().api, 'B11-without-monotonicity');
      const sigmaA = shapeOf(arith, 'sigmaA');
      const sigmaB = shapeOf(arith, 'sigmaB');
      const excess = shapeOf(arith, 'excess');
      const split = movedSplit(arith, sigmaA, '');
      const restB = arith.int('restB');
      const saving = arith.int('saving');
      arith.given(restB.ge(0), saving.ge(1), saving.le(restB));
      const shorter = restB.sub(saving);
      const model = await expectRefuted(arith, loadAt(split, sigmaB, excess, shorter).le(loadAt(split, sigmaB, excess, restB)));
      expect(Object.keys(model)).toEqual(expect.arrayContaining(['kept', 'restA', 'restB', 'saving']));
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  it(
    'evidence: a per-member rule refuses a pass that fits, because its first member pays the whole cost of moving j',
    async () => {
      const arith = proofArith(z3.engine().api, 'B11-per-member');
      const { ctx } = arith;
      const sigmaA = shapeOf(arith, 'sigmaA');
      const sigmaB = shapeOf(arith, 'sigmaB');
      const excess = shapeOf(arith, 'excess');
      const inputBudget = arith.int('inputBudget');
      const kept = arith.int('keptReported');
      const added = arith.int('added');
      const unmoved: Split = { known: kept, restA: ctx.Int.val(0), fixedA: ctx.Int.val(0) };
      const moved = movedSplit(arith, sigmaA, 'moved');
      const first = arith.int('firstSaving');
      const behind = arith.int('behindSaving');
      arith.given(inputBudget.ge(0), kept.ge(0), added.ge(0), first.ge(1), behind.ge(1));
      arith.given(moved.restA.ge(1));
      const restBeforeMove = moved.restA.add(added);
      const memberAlone = restBeforeMove.sub(first);
      const pass = memberAlone.sub(behind);
      arith.given(pass.ge(0));
      for (const [low, high] of [
        [pass, memberAlone],
        [memberAlone, restBeforeMove],
      ] as const) {
        sigmaB.monotone(low, high);
        excess.monotone(moved.restA.add(low), moved.restA.add(high));
      }
      arith.given(moved.restA.le(kept));
      const keptLoad = loadAt(unmoved, sigmaB, excess, added);
      const aloneLoad = loadAt(moved, sigmaB, excess, memberAlone);
      const passLoad = loadAt(moved, sigmaB, excess, pass);
      arith.given(keptLoad.le(inputBudget));
      const perMemberRefusesAFittingPass = ctx.And(aloneLoad.gt(keptLoad), aloneLoad.gt(inputBudget), passLoad.le(inputBudget));
      const model = await expectRefuted(arith, ctx.Not(perMemberRefusesAFittingPass));
      expect(Object.keys(model)).toEqual(expect.arrayContaining(['inputBudget', 'keptReported', 'firstSaving', 'behindSaving']));
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  it(
    'evidence: the measured case of observation 1, 2599+10 kept, 2588+632 with the first member, 2226+523 with the pass, against I0 2990',
    async () => {
      const arith = proofArith(z3.engine().api, 'B11-measured');
      const { ctx } = arith;
      const value = (number: number): ProofInt => ctx.Int.val(number);
      const sigma = (tokens: ProofInt): ProofInt => arith.ceilRatio(0.3, tokens);
      const loadOf = (known: number, restA: number, restB: number): ProofInt =>
        value(known + restB).add(sigma(value(restA))).add(sigma(value(restB)));
      const kept = loadOf(2568, 0, 31);
      const alone = loadOf(1527, 2568 - 1527, 2588 - 1527);
      const pass = loadOf(1527, 2568 - 1527, 2226 - 1527);
      const inputBudget = value(2990);
      expect(await prove(arith, ctx.And(kept.le(inputBudget), alone.gt(inputBudget), pass.le(inputBudget), pass.lt(alone)))).toEqual({ status: 'proved' });
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );
});
