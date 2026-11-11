import { describe, expect, it } from 'vitest';
import { proofArith } from '../support/proofs/arith.ts';
import type { ProofArith, ProofInt } from '../support/proofs/arith.ts';
import { expectRefuted, prove } from '../support/proofs/prove.ts';
import { SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS, useZ3 } from '../harness.ts';

const satisfiable = async (arith: ProofArith): Promise<boolean> => {
  const solver = new arith.ctx.Solver();
  solver.add(...arith.assertions());
  return (await solver.check()) === 'sat';
};

const timeoutOf = (arith: ProofArith, requested: ProofInt, remaining: ProofInt): ProofInt => arith.max(arith.ctx.Int.val(0n), arith.min(requested, remaining));

describe('HB1 and HB4: the deadline chain', () => {
  const z3 = useZ3();

  it(
    'C1 proves timeoutMs = max(0, min(requested, remaining)) is non-negative, at most the request, at most the remaining time when that is not negative, and 0 when it is',
    async () => {
      const arith = proofArith(z3.engine().api, 'C1');
      const requested = arith.int('requested');
      const remaining = arith.int('remaining');
      arith.given(requested.ge(0));
      const timeout = timeoutOf(arith, requested, remaining);
      const { ctx } = arith;
      expect(await satisfiable(arith)).toBe(true);
      const goal = ctx.And(timeout.ge(0), timeout.le(requested), ctx.Implies(remaining.ge(0), timeout.le(remaining)), ctx.Implies(remaining.lt(0), timeout.eq(0)));
      expect(await prove(arith, goal)).toEqual({ status: 'proved' });
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  it(
    'C2 proves that with the strict rule call-timeout iff requested < remaining, exactly one of call-timeout and run-deadline holds for every pair, and a call-timeout leaves the run strictly more than 0 ms',
    async () => {
      const arith = proofArith(z3.engine().api, 'C2');
      const requested = arith.int('requested');
      const remaining = arith.int('remaining');
      arith.given(requested.ge(0), remaining.ge(0));
      const { ctx } = arith;
      const callTimeout = requested.lt(remaining);
      const runDeadline = ctx.Not(callTimeout);
      const timeout = timeoutOf(arith, requested, remaining);
      expect(await satisfiable(arith)).toBe(true);
      const exclusive = ctx.And(ctx.Or(callTimeout, runDeadline), ctx.Not(ctx.And(callTimeout, runDeadline)));
      expect(await prove(arith, exclusive)).toEqual({ status: 'proved' });
      expect(await prove(arith, ctx.Implies(callTimeout, remaining.sub(timeout).gt(0)))).toEqual({ status: 'proved' });
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  it(
    'C2w refutes that a call-timeout under the non-strict rule requested <= remaining leaves the run more than 0 ms, with the tie requested = remaining as the counter-example',
    async () => {
      const arith = proofArith(z3.engine().api, 'C2w');
      const requested = arith.int('requested');
      const remaining = arith.int('remaining');
      arith.given(requested.ge(0), remaining.ge(0));
      const { ctx } = arith;
      const timeout = timeoutOf(arith, requested, remaining);
      const model = await expectRefuted(arith, ctx.Implies(requested.le(remaining), remaining.sub(timeout).gt(0)));
      expect(model.requested).toBe(model.remaining);
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  it(
    'C3 proves Deadline.fromWall remaining is max(0, d - wall) at construction, never negative, 0 exactly when the wall time has reached d, and afterwards counts down in monotonic time only',
    async () => {
      const arith = proofArith(z3.engine().api, 'C3');
      const deadlineAt = arith.int('d');
      const wall = arith.int('wall');
      const elapsed = arith.int('elapsed');
      arith.given(elapsed.ge(0));
      const { ctx } = arith;
      const remaining = arith.max(ctx.Int.val(0n), deadlineAt.sub(wall));
      const later = arith.max(ctx.Int.val(0n), remaining.sub(elapsed));
      expect(await satisfiable(arith)).toBe(true);
      expect(await prove(arith, ctx.And(remaining.ge(0), ctx.Implies(wall.ge(deadlineAt), remaining.eq(0)), ctx.Implies(wall.lt(deadlineAt), remaining.eq(deadlineAt.sub(wall)))))).toEqual({ status: 'proved' });
      expect(await prove(arith, ctx.And(later.ge(0), later.le(remaining), ctx.Implies(elapsed.ge(remaining), later.eq(0))))).toEqual({ status: 'proved' });
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  it(
    'C4 proves that with the wall-skew rule a call timeout that fires with wallRemaining <= 0 is run-deadline, so the two causes stay exclusive and total and every call-timeout leaves both clocks strictly more than 0 ms',
    async () => {
      const arith = proofArith(z3.engine().api, 'C4');
      const requested = arith.int('requested');
      const remaining = arith.int('remaining');
      const wallRemaining = arith.int('wallRemaining');
      arith.given(requested.ge(0), remaining.ge(0));
      const { ctx } = arith;
      const callTimeout = ctx.And(requested.lt(remaining), wallRemaining.gt(0));
      const runDeadline = ctx.Not(callTimeout);
      expect(await satisfiable(arith)).toBe(true);
      expect(await prove(arith, ctx.And(ctx.Or(callTimeout, runDeadline), ctx.Not(ctx.And(callTimeout, runDeadline))))).toEqual({ status: 'proved' });
      expect(await prove(arith, ctx.Implies(callTimeout, ctx.And(remaining.sub(requested).gt(0), wallRemaining.gt(0))))).toEqual({ status: 'proved' });
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  it(
    'C4w refutes that a call-timeout decided by requested < remaining alone leaves the wall clock more than 0 ms, with a suspend that moved the wall clock past the deadline as the counter-example',
    async () => {
      const arith = proofArith(z3.engine().api, 'C4w');
      const requested = arith.int('requested');
      const remaining = arith.int('remaining');
      const wallRemaining = arith.int('wallRemaining');
      arith.given(requested.ge(0), remaining.ge(0));
      const model = await expectRefuted(arith, arith.ctx.Implies(requested.lt(remaining), wallRemaining.gt(0)));
      expect(BigInt(model.wallRemaining as string)).toBeLessThanOrEqual(0n);
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  it(
    'C3w refutes that a remaining time read from the wall clock equals the monotonic remaining time after a wall step, which is today Deadline.remainingMs against its timer',
    async () => {
      const arith = proofArith(z3.engine().api, 'C3w');
      const duration = arith.int('duration');
      const elapsed = arith.int('elapsed');
      const step = arith.int('wallStep');
      arith.given(duration.ge(0), elapsed.ge(0), elapsed.le(duration));
      const monotonicRemaining = duration.sub(elapsed);
      const wallRemaining = duration.sub(elapsed.add(step));
      expect(await satisfiable(arith)).toBe(true);
      const model = await expectRefuted(arith, wallRemaining.eq(monotonicRemaining));
      expect(model.wallStep).not.toBe('0');
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );
});
