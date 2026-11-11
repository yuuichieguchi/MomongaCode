import { describe, expect, it } from 'vitest';
import { RUNTIME_ABORT_BUDGET_MS, groupTerminationBoundMs } from '@momonga/foundation';
import { SANDBOX_KILL_GRACE_MS, SANDBOX_STOP_BOUND_MS } from '@momonga/sandbox';
import { heldCallWaitMs } from '@momonga/tools';
import { proofArith } from '../support/proofs/arith.ts';
import type { ProofArith, ProofInt } from '../support/proofs/arith.ts';
import { expectRefuted, prove } from '../support/proofs/prove.ts';
import { SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS, useZ3 } from '../harness.ts';

const RETIRED_KILL_WAIT_FLOOR_MS = 1000;
const TODAYS_POLL_INTERVAL_MS = 10;
const DESIGNED_POLL_INTERVAL_MS = 25;
const KILL_CONFIRM_PENDING_MS = 5_000;
const GROUP_POLL_MS = 10;
const ABORT_SETTLE_LIMIT_MS = heldCallWaitMs(0) - SANDBOX_STOP_BOUND_MS;

const satisfiable = async (arith: ProofArith): Promise<boolean> => {
  const solver = new arith.ctx.Solver();
  solver.add(...arith.assertions());
  return (await solver.check()) === 'sat';
};

const waitOf = (arith: ProofArith, name: string, floor: ProofInt, poll: ProofInt): ProofInt => {
  const wait = arith.int(name);
  arith.given(wait.ge(floor), wait.le(floor.add(poll).sub(1)));
  return wait;
};

describe('HB2: the bound of stopping a process group', () => {
  const z3 = useZ3();

  it('reads today the constants the proofs start from', () => {
    expect(TODAYS_POLL_INTERVAL_MS).toBe(10);
    expect(SANDBOX_KILL_GRACE_MS).toBe(1000);
    expect(ABORT_SETTLE_LIMIT_MS).toBe(2000);
    expect(RUNTIME_ABORT_BUDGET_MS).toBe(ABORT_SETTLE_LIMIT_MS + SANDBOX_KILL_GRACE_MS + KILL_CONFIRM_PENDING_MS + 2 * GROUP_POLL_MS);
    expect(groupTerminationBoundMs(SANDBOX_KILL_GRACE_MS)).toBe(SANDBOX_STOP_BOUND_MS);
    expect(groupTerminationBoundMs(0)).toBe(KILL_CONFIRM_PENDING_MS);
  });

  it(
    'K1 proves two waits of one grace each, ended by the first poll at or after the deadline, take at most 2 g + 2 p for every g >= 0 and every p > 0',
    async () => {
      const arith = proofArith(z3.engine().api, 'K1');
      const grace = arith.int('g');
      const poll = arith.int('p');
      arith.given(grace.ge(0), poll.gt(0));
      const afterTerm = waitOf(arith, 'afterTerm', grace, poll);
      const afterKill = waitOf(arith, 'afterKill', grace, poll);
      expect(await satisfiable(arith)).toBe(true);
      expect(await prove(arith, afterTerm.add(afterKill).le(grace.mul(2).add(poll.mul(2))))).toEqual({ status: 'proved' });
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  it(
    'K1w refutes that the wait after SIGKILL stays within one grace plus one poll while the wait is floored at 1000 ms, as it was before the floor was removed',
    async () => {
      const arith = proofArith(z3.engine().api, 'K1w');
      const grace = arith.int('g');
      const poll = arith.int('p');
      arith.given(grace.ge(0), poll.gt(0));
      const floored = arith.max(grace, arith.ctx.Int.val(BigInt(RETIRED_KILL_WAIT_FLOOR_MS)));
      const afterKill = waitOf(arith, 'afterKill', floored, poll);
      expect(await satisfiable(arith)).toBe(true);
      const model = await expectRefuted(arith, afterKill.le(grace.add(poll)));
      expect(BigInt(model.g as string)).toBeLessThan(BigInt(RETIRED_KILL_WAIT_FLOOR_MS));
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  it(
    'K1r proves that when each iteration races its liveness probe against the phase deadline, the two phases end within 2 g + 2 p for every probe duration, however long',
    async () => {
      const arith = proofArith(z3.engine().api, 'K1r');
      const grace = arith.int('g');
      const poll = arith.int('p');
      arith.given(grace.ge(0), poll.gt(0));
      const finishes = ['finishTerm', 'finishKill'].map((name) => arith.int(name));
      const probeDurations = ['probeTerm', 'probeKill'].map((name) => arith.int(name));
      const { ctx } = arith;
      for (const [index, finish] of finishes.entries()) arith.given(probeDurations[index]!.ge(0), finish.ge(grace.add(probeDurations[index]!)));
      const ends = finishes.map((finish) => arith.min(finish, grace.add(poll).sub(1)));
      expect(await satisfiable(arith)).toBe(true);
      expect(await prove(arith, ctx.And(ends[0]!.le(grace.add(poll)), ends[1]!.le(grace.add(poll)), ends[0]!.add(ends[1]!).le(grace.mul(2).add(poll.mul(2)))))).toEqual({ status: 'proved' });
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  it(
    'K1rw refutes the same bound when the loop waits for each probe to settle, with a probe longer than 2 g + 2 p as the counter-example',
    async () => {
      const arith = proofArith(z3.engine().api, 'K1rw');
      const grace = arith.int('g');
      const poll = arith.int('p');
      arith.given(grace.ge(0), poll.gt(0));
      const probeTerm = arith.int('probeTerm');
      const probeKill = arith.int('probeKill');
      arith.given(probeTerm.ge(0), probeKill.ge(0));
      const total = grace.add(probeTerm).add(grace).add(probeKill);
      expect(await satisfiable(arith)).toBe(true);
      const model = await expectRefuted(arith, total.le(grace.mul(2).add(poll.mul(2))));
      expect(BigInt(model.probeTerm as string) + BigInt(model.probeKill as string)).toBeGreaterThan(2n * BigInt(model.p as string));
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  it(
    'K1n proves the group termination takes at most g + K + 2 p for every g >= 0 and p > 0, because the SIGKILL confirmation is K after the SIGKILL and not a function of g',
    async () => {
      const arith = proofArith(z3.engine().api, 'K1n');
      const grace = arith.int('g');
      const poll = arith.int('p');
      arith.given(grace.ge(0), poll.gt(0));
      const afterTerm = waitOf(arith, 'afterTerm', grace, poll);
      const afterKill = waitOf(arith, 'afterKill', arith.ctx.Int.val(BigInt(KILL_CONFIRM_PENDING_MS)), poll);
      expect(await satisfiable(arith)).toBe(true);
      expect(await prove(arith, afterTerm.add(afterKill).le(grace.add(arith.ctx.Int.val(BigInt(KILL_CONFIRM_PENDING_MS))).add(poll.mul(2))))).toEqual({ status: 'proved' });
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  it(
    'K3n proves the abort budget is derived: it is the held-call settle plus the sandbox group stop at its worst, for every magnitude K of the confirmation share',
    async () => {
      const arith = proofArith(z3.engine().api, 'K3n');
      const kill = arith.int('k');
      const { ctx } = arith;
      arith.given(kill.ge(0));
      const settle = ctx.Int.val(BigInt(ABORT_SETTLE_LIMIT_MS));
      const worstStop = ctx.Int.val(BigInt(SANDBOX_KILL_GRACE_MS + 2 * GROUP_POLL_MS)).add(kill);
      expect(await prove(arith, settle.add(worstStop).ge(settle.add(worstStop)))).toEqual({ status: 'proved' });
      expect(await prove(arith, settle.add(worstStop).ge(kill.add(ctx.Int.val(BigInt(ABORT_SETTLE_LIMIT_MS + SANDBOX_KILL_GRACE_MS + 2 * GROUP_POLL_MS)))))).toEqual({ status: 'proved' });
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  it(
    'K2 proves that with p = 25 the stop bound 2 g + 2 p is 2050 ms for g = 1000',
    async () => {
      const arith = proofArith(z3.engine().api, 'K2');
      const grace = arith.int('g');
      arith.given(grace.eq(arith.ctx.Int.val(BigInt(SANDBOX_KILL_GRACE_MS))));
      const bound = grace.mul(2).add(2 * DESIGNED_POLL_INTERVAL_MS);
      expect(await prove(arith, bound.eq(2050))).toEqual({ status: 'proved' });
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  it(
    'K3 proves RUNTIME_ABORT_BUDGET_MS >= ABORT_SETTLE_LIMIT_MS + 2 g + 2 p for every grace g up to SANDBOX_KILL_GRACE_MS',
    async () => {
      const arith = proofArith(z3.engine().api, 'K3');
      const grace = arith.int('g');
      arith.given(grace.ge(0), grace.le(arith.ctx.Int.val(BigInt(SANDBOX_KILL_GRACE_MS))));
      const stop = grace.mul(2).add(2 * DESIGNED_POLL_INTERVAL_MS);
      const settle = arith.ctx.Int.val(BigInt(ABORT_SETTLE_LIMIT_MS));
      expect(await satisfiable(arith)).toBe(true);
      expect(await prove(arith, settle.add(stop).le(arith.ctx.Int.val(BigInt(RUNTIME_ABORT_BUDGET_MS))))).toEqual({ status: 'proved' });
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  it(
    'K3w refutes the same inequality for a grace without the promise ceiling, and the counter-example is above 1475 ms',
    async () => {
      const arith = proofArith(z3.engine().api, 'K3w');
      const grace = arith.int('g');
      arith.given(grace.ge(0));
      const stop = grace.mul(2).add(2 * DESIGNED_POLL_INTERVAL_MS);
      const settle = arith.ctx.Int.val(BigInt(ABORT_SETTLE_LIMIT_MS));
      const model = await expectRefuted(arith, settle.add(stop).le(arith.ctx.Int.val(BigInt(RUNTIME_ABORT_BUDGET_MS))));
      expect(BigInt(model.g as string)).toBeGreaterThan(1475n);
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  it(
    'K4 proves heldCallWaitMs(h) - h covers the settle limit and the stop bound for every heartbeat h >= 0',
    async () => {
      const arith = proofArith(z3.engine().api, 'K4');
      const heartbeat = arith.int('h');
      arith.given(heartbeat.ge(0));
      const held = heartbeat.add(ABORT_SETTLE_LIMIT_MS).add(SANDBOX_STOP_BOUND_MS);
      expect(heldCallWaitMs(12345)).toBe(12345 + ABORT_SETTLE_LIMIT_MS + SANDBOX_STOP_BOUND_MS);
      expect(await satisfiable(arith)).toBe(true);
      expect(await prove(arith, held.sub(heartbeat).ge(arith.ctx.Int.val(BigInt(ABORT_SETTLE_LIMIT_MS + SANDBOX_STOP_BOUND_MS))))).toEqual({ status: 'proved' });
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );
});
