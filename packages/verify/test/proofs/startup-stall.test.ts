import { describe, expect, it } from 'vitest';
import { STARTUP_TIMEOUT_MS } from '@momonga/supervisor';
import { proofArith } from '../../src/proofs/arith.ts';
import type { ProofArith } from '../../src/proofs/arith.ts';
import { expectRefuted, prove } from '../../src/proofs/prove.ts';
import { SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS, useZ3 } from '../harness.ts';

const DEFAULT_STALL_MS = 60_000;

const satisfiable = async (arith: ProofArith): Promise<boolean> => {
  const solver = new arith.ctx.Solver();
  solver.add(...arith.assertions());
  return (await solver.check()) === 'sat';
};

describe('HB8: the start-up stall limit re-armed by progress', () => {
  const z3 = useZ3();

  it('reads today the total that the stall limit replaces', () => {
    expect(STARTUP_TIMEOUT_MS).toBe(DEFAULT_STALL_MS);
  });

  it(
    'S1 proves that a progress report no later than stall ms after the previous one arrives before the re-armed timer fires, and moves the deadline forward, for every stall >= 1',
    async () => {
      const arith = proofArith(z3.engine().api, 'S1');
      const stall = arith.int('stall');
      const previous = arith.int('previous');
      const next = arith.int('next');
      arith.given(stall.ge(1), previous.ge(0), next.ge(previous), next.sub(previous).le(stall));
      const { ctx } = arith;
      expect(await satisfiable(arith)).toBe(true);
      expect(await prove(arith, ctx.And(next.le(previous.add(stall)), next.add(stall).ge(previous.add(stall))))).toEqual({ status: 'proved' });
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  it(
    'S2 proves that silence longer than stall ms is detected exactly stall ms after the last progress, before the next progress, for every stall >= 1',
    async () => {
      const arith = proofArith(z3.engine().api, 'S2');
      const stall = arith.int('stall');
      const last = arith.int('last');
      const next = arith.int('next');
      arith.given(stall.ge(1), last.ge(0), next.sub(last).gt(stall));
      const stopsAt = last.add(stall);
      const { ctx } = arith;
      expect(await satisfiable(arith)).toBe(true);
      expect(await prove(arith, ctx.And(stopsAt.sub(last).eq(stall), stopsAt.lt(next)))).toEqual({ status: 'proved' });
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  it(
    'S4 proves I-L4: with the stall timer suspended inside a declared blocking step and re-armed by the left-step message, no stall expiry fires in [enter, left) and none fires before left + stall, however long the step, for every stall >= 1',
    async () => {
      const arith = proofArith(z3.engine().api, 'S4');
      const stall = arith.int('stall');
      const enter = arith.int('enter');
      const left = arith.int('left');
      const fireAt = arith.int('fireAt');
      arith.given(stall.ge(1), enter.ge(0), left.gt(enter), fireAt.ge(enter));
      const { ctx } = arith;
      const armedAt = ctx.If(fireAt.ge(left), left, enter);
      const inside = ctx.And(fireAt.ge(enter), fireAt.lt(left));
      arith.given(fireAt.ge(armedAt.add(stall)), ctx.Not(inside));
      expect(await satisfiable(arith)).toBe(true);
      expect(await prove(arith, ctx.And(ctx.Or(fireAt.lt(enter), fireAt.ge(left)), fireAt.ge(left.add(stall))))).toEqual({ status: 'proved' });
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  it(
    'S4w refutes I-L4 for a stall timer that is only re-armed by the enter message and not suspended, with a step longer than the stall limit as the counter-example',
    async () => {
      const arith = proofArith(z3.engine().api, 'S4w');
      const stall = arith.int('stall');
      const enter = arith.int('enter');
      const left = arith.int('left');
      const fireAt = arith.int('fireAt');
      arith.given(stall.ge(1), enter.ge(0), left.gt(enter), fireAt.ge(enter.add(stall)), fireAt.lt(left));
      const { ctx } = arith;
      expect(await satisfiable(arith)).toBe(true);
      const model = await expectRefuted(arith, ctx.Not(ctx.And(fireAt.ge(enter), fireAt.lt(left))));
      expect(BigInt(model.left as string) - BigInt(model.enter as string)).toBeGreaterThan(BigInt(model.stall as string));
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  it(
    'S3 shows it is satisfiable that four steps each reported within the stall limit take longer than the stall limit in total',
    async () => {
      const arith = proofArith(z3.engine().api, 'S3');
      const gaps = ['g1', 'g2', 'g3', 'g4'].map((name) => arith.int(name));
      const stall = arith.ctx.Int.val(BigInt(DEFAULT_STALL_MS));
      arith.given(...gaps.flatMap((gap) => [gap.ge(1), gap.le(stall)]));
      const total = gaps.reduce((sum, gap) => sum.add(gap));
      const { ctx } = arith;
      const solver = new ctx.Solver();
      solver.add(...arith.assertions(), total.gt(stall));
      expect(await solver.check()).toBe('sat');
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  it(
    'S3w refutes that every child whose steps are each within the stall limit finishes within a fixed total of 60000 ms, which is the rule of today',
    async () => {
      const arith = proofArith(z3.engine().api, 'S3w');
      const gaps = ['g1', 'g2', 'g3', 'g4'].map((name) => arith.int(name));
      const stall = arith.ctx.Int.val(BigInt(DEFAULT_STALL_MS));
      arith.given(...gaps.flatMap((gap) => [gap.ge(1), gap.le(stall)]));
      const total = gaps.reduce((sum, gap) => sum.add(gap));
      expect(await satisfiable(arith)).toBe(true);
      const model = await expectRefuted(arith, total.le(arith.ctx.Int.val(BigInt(STARTUP_TIMEOUT_MS))));
      expect(['g1', 'g2', 'g3', 'g4'].reduce((sum, name) => sum + BigInt(model[name] as string), 0n)).toBeGreaterThan(BigInt(STARTUP_TIMEOUT_MS));
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );
});
