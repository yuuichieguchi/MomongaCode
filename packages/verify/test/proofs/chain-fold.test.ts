import { describe, expect, it } from 'vitest';
import { MARGIN, MIN_MARGIN, OUTPUT_RESERVE } from '@momonga/protocol';
import { proofArith } from '../../src/proofs/arith.ts';
import type { ProofArith, ProofInt } from '../../src/proofs/arith.ts';
import { expectRefuted, prove } from '../../src/proofs/prove.ts';
import { SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS, useZ3 } from '../harness.ts';
import { MAX_WINDOW, ceilOf, hypothesesSatisfiable, named } from './budget-model.ts';

type Fold = { readonly W: ProofInt; readonly U: ProofInt };

const inDomain = (arith: ProofArith, name: string): ProofInt => {
  const value = arith.int(name);
  arith.given(value.ge(1), value.le(arith.ctx.Int.val(MAX_WINDOW)));
  return value;
};

const marginOf = (arith: ProofArith, label: string, window: ProofInt): ProofInt =>
  named(arith, label, arith.max(ceilOf(arith, MARGIN, window), arith.ctx.Int.val(MIN_MARGIN)));

const roomOf = (arith: ProofArith, label: string, fold: Fold): ProofInt => fold.W.sub(fold.U).sub(marginOf(arith, `margin${label}`, fold.W));

const requiredOf = (arith: ProofArith, label: string, fold: Fold): ProofInt => named(arith, `required${label}`, ceilOf(arith, OUTPUT_RESERVE, fold.W));

const slackOf = (arith: ProofArith, label: string, fold: Fold): ProofInt => roomOf(arith, label, fold).sub(requiredOf(arith, label, fold));

const extended = (arith: ProofArith, fold: Fold, window: ProofInt, maxOutput: ProofInt): Fold => ({ W: arith.min(fold.W, window), U: arith.max(fold.U, maxOutput) });

describe('CF: the room of a chain of any length is the fold of its members (design-model-names 3.2, 7.1)', () => {
  const z3 = useZ3();

  it(
    'CF1 a chain of two members (W, 1) and (max(W, U), U) is a chain of the domain whose fold is (W, U), for every W and U in [1, 2^33]; so every pair of the domain is the fold of a chain of two, and of three, members',
    async () => {
      const arith = proofArith(z3.engine().api, 'CF1');
      const W = inDomain(arith, 'W');
      const U = inDomain(arith, 'U');
      const wideWindow = arith.max(W, U);
      const first = { window: W, maxOutput: arith.ctx.Int.val(1) };
      const second = { window: wideWindow, maxOutput: U };
      const { ctx } = arith;
      const memberOk = (member: { readonly window: ProofInt; readonly maxOutput: ProofInt }) =>
        ctx.And(member.window.ge(1), member.window.le(ctx.Int.val(MAX_WINDOW)), member.maxOutput.ge(1), member.maxOutput.le(member.window));
      const smallest = arith.min(first.window, second.window);
      const largest = arith.max(first.maxOutput, second.maxOutput);
      expect(await hypothesesSatisfiable(arith)).toBe(true);
      expect(await prove(arith, ctx.And(memberOk(first), memberOk(second), smallest.eq(W), largest.eq(U)))).toEqual({ status: 'proved' });
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  it(
    'CF2 adding any member of the domain to a chain keeps the fold in the domain, never raises the smallest window and never lowers the largest output, for every fold and member',
    async () => {
      const arith = proofArith(z3.engine().api, 'CF2');
      const { ctx } = arith;
      const fold = { W: inDomain(arith, 'W'), U: inDomain(arith, 'U') };
      const window = inDomain(arith, 'w');
      const maxOutput = arith.int('o');
      arith.given(maxOutput.ge(1), maxOutput.le(window));
      const next = extended(arith, fold, window, maxOutput);
      expect(await hypothesesSatisfiable(arith)).toBe(true);
      const inRange = (value: ProofInt) => ctx.And(value.ge(1), value.le(ctx.Int.val(MAX_WINDOW)));
      expect(await prove(arith, ctx.And(inRange(next.W), inRange(next.U), next.W.le(fold.W), next.U.ge(fold.U)))).toEqual({ status: 'proved' });
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  it(
    'CF3 the room W - U - marginFloorFor(W) of a chain never rises when a member is added, for every fold and member of the domain',
    async () => {
      const arith = proofArith(z3.engine().api, 'CF3');
      const fold = { W: inDomain(arith, 'W'), U: inDomain(arith, 'U') };
      const window = inDomain(arith, 'w');
      const maxOutput = arith.int('o');
      arith.given(maxOutput.ge(1), maxOutput.le(window));
      const next = extended(arith, fold, window, maxOutput);
      const before = named(arith, 'room', roomOf(arith, 'Before', fold));
      const after = named(arith, 'roomAfter', roomOf(arith, 'After', next));
      expect(await hypothesesSatisfiable(arith)).toBe(true);
      expect(await prove(arith, after.le(before))).toEqual({ status: 'proved' });
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  it(
    'CF3 evidence: the required input room ceil(W / 4) of a chain does fall when a member with a smaller window is added, so "required never lowers" does not hold',
    async () => {
      const arith = proofArith(z3.engine().api, 'CF3-required');
      const fold = { W: inDomain(arith, 'W'), U: inDomain(arith, 'U') };
      const window = inDomain(arith, 'w');
      const maxOutput = arith.int('o');
      arith.given(maxOutput.ge(1), maxOutput.le(window));
      const next = extended(arith, fold, window, maxOutput);
      const before = requiredOf(arith, 'Before', fold);
      const after = requiredOf(arith, 'After', next);
      expect(await hypothesesSatisfiable(arith)).toBe(true);
      const model = await expectRefuted(arith, after.ge(before));
      expect(BigInt(String(model.W))).toBeGreaterThan(BigInt(String(model.w)));
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  it(
    'CF3 evidence: the slack room - required of a chain is not monotone, so adding a member can turn a refusal into a serve; the verdict is that of the members the chain has',
    async () => {
      const arith = proofArith(z3.engine().api, 'CF3-slack');
      const fold = { W: inDomain(arith, 'W'), U: inDomain(arith, 'U') };
      const window = inDomain(arith, 'w');
      const maxOutput = arith.int('o');
      arith.given(maxOutput.ge(1), maxOutput.le(window));
      const next = extended(arith, fold, window, maxOutput);
      const before = slackOf(arith, 'Before', fold);
      const after = slackOf(arith, 'After', next);
      expect(await hypothesesSatisfiable(arith)).toBe(true);
      await expectRefuted(arith, after.le(before));
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );
});
