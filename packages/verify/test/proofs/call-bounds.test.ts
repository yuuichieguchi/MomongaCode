import { describe, expect, it } from 'vitest';
import { MCP_TOOL_IDLE_TIMEOUT_MS, MCP_TOOL_TOTAL_TIMEOUT_MS, MIN_TASK_POLL_MS, pollCeilingMs, pollDelayMs } from '@momonga/mcp';
import { callStopOf } from '@momonga/tools';
import { proofArith } from '../support/proofs/arith.ts';
import type { ProofArith, ProofInt } from '../support/proofs/arith.ts';
import { expectRefuted, prove } from '../support/proofs/prove.ts';
import { SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS, useZ3 } from '../harness.ts';

const satisfiable = async (arith: ProofArith): Promise<boolean> => {
  const solver = new arith.ctx.Solver();
  solver.add(...arith.assertions());
  return (await solver.check()) === 'sat';
};

type Call = { start: ProofInt; progress: ProofInt; idle: ProofInt; total: ProofInt; deadline: ProofInt };

const callOf = (arith: ProofArith): Call => {
  const call = { start: arith.int('start'), progress: arith.int('progress'), idle: arith.int('idle'), total: arith.int('total'), deadline: arith.int('deadline') };
  arith.given(call.progress.ge(call.start), call.idle.gt(0), call.total.gt(0));
  return call;
};

const fireAtOf = (arith: ProofArith, call: Call): ProofInt => arith.min(arith.min(call.progress.add(call.idle), call.start.add(call.total)), call.deadline);

const pollDelayOf = (arith: ProofArith, hint: ProofInt, ceiling: ProofInt): ProofInt => arith.max(arith.ctx.Int.val(BigInt(MIN_TASK_POLL_MS)), arith.min(hint, ceiling));

describe('G2: the end of a call is the earliest of its idle window, its overall limit and the run deadline (audit-unbounded-waits-2026-11-07.md, R-G2a)', () => {
  const z3 = useZ3();

  it('reads the formula of the code: callStopOf and pollDelayMs agree with the terms the proofs use', () => {
    for (const [start, progress, idle, total, deadline] of [
      [0, 0, 300_000, MCP_TOOL_TOTAL_TIMEOUT_MS, 21_600_000],
      [0, 21_500_000, 300_000, MCP_TOOL_TOTAL_TIMEOUT_MS, 21_600_000],
      [5, 100_800_000, 1_800_000, MCP_TOOL_TOTAL_TIMEOUT_MS, 604_800_000],
    ] as const) {
      expect(callStopOf({ startedAt: start, lastProgressAt: progress, idleMs: idle, totalMs: total, deadlineAt: deadline }).at).toBe(Math.min(progress + idle, start + total, deadline));
    }
    for (const [hint, ceiling] of [
      [3_600_000, 150_000],
      [10, 150_000],
      [2_000, 150_000],
      [3_600_000, 100],
    ] as const) {
      expect(pollDelayMs(hint, ceiling)).toBe(Math.max(MIN_TASK_POLL_MS, Math.min(hint, ceiling)));
    }
    expect(pollCeilingMs(MCP_TOOL_IDLE_TIMEOUT_MS.network, MCP_TOOL_TOTAL_TIMEOUT_MS)).toBe(Math.floor(MCP_TOOL_IDLE_TIMEOUT_MS.network / 2));
  });

  it(
    'B1 proves, for every start, last progress, idle window, overall limit and deadline, that the call ends no later than its overall limit, the run deadline and one idle window after its last progress',
    async () => {
      const arith = proofArith(z3.engine().api, 'B1');
      const call = callOf(arith);
      const fireAt = fireAtOf(arith, call);
      expect(await satisfiable(arith)).toBe(true);
      const { ctx } = arith;
      const goal = ctx.And(fireAt.le(call.start.add(call.total)), fireAt.le(call.deadline), fireAt.le(call.progress.add(call.idle)));
      expect(await prove(arith, goal)).toEqual({ status: 'proved' });
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  it(
    'B2 proves that progress never moves the end of a call past its overall limit: a later progress gives an end no later than start + total',
    async () => {
      const arith = proofArith(z3.engine().api, 'B2');
      const call = callOf(arith);
      const later = arith.int('later');
      arith.given(later.ge(call.progress));
      const moved = fireAtOf(arith, { ...call, progress: later });
      expect(await satisfiable(arith)).toBe(true);
      expect(await prove(arith, moved.le(call.start.add(call.total)))).toEqual({ status: 'proved' });
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  it(
    'B1w refutes the overall limit under the old rule, where a task checkpoint extended the call to the run deadline',
    async () => {
      const arith = proofArith(z3.engine().api, 'B1w');
      const call = callOf(arith);
      const extended = call.deadline;
      expect(await satisfiable(arith)).toBe(true);
      await expectRefuted(arith, extended.le(call.start.add(call.total)));
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  it(
    'B3 proves that the poll delay clamped to half the idle window leaves two polls in every window once the window is at least two floors, and never falls below the floor',
    async () => {
      const arith = proofArith(z3.engine().api, 'B3');
      const idle = arith.int('idle');
      const hint = arith.int('hint');
      arith.given(idle.ge(2 * MIN_TASK_POLL_MS), hint.ge(0));
      const delay = pollDelayOf(arith, hint, arith.floorDiv(idle, 2n));
      expect(await satisfiable(arith)).toBe(true);
      const { ctx } = arith;
      expect(await prove(arith, ctx.And(delay.mul(2).le(idle), delay.ge(MIN_TASK_POLL_MS)))).toEqual({ status: 'proved' });
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  it(
    'B3w refutes two polls per window without the clamp, the old rule max(floor, hint)',
    async () => {
      const arith = proofArith(z3.engine().api, 'B3w');
      const idle = arith.int('idle');
      const hint = arith.int('hint');
      arith.given(idle.ge(2 * MIN_TASK_POLL_MS), hint.ge(0));
      const unclamped = arith.max(arith.ctx.Int.val(BigInt(MIN_TASK_POLL_MS)), hint);
      expect(await satisfiable(arith)).toBe(true);
      await expectRefuted(arith, unclamped.mul(2).le(idle));
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  it('B4: the defaults of decision 8 hold two floors in each idle window and fit the overall limit', () => {
    for (const idle of Object.values(MCP_TOOL_IDLE_TIMEOUT_MS)) {
      expect(idle).toBeGreaterThanOrEqual(2 * MIN_TASK_POLL_MS);
      expect(idle).toBeLessThan(MCP_TOOL_TOTAL_TIMEOUT_MS);
    }
  });
});
