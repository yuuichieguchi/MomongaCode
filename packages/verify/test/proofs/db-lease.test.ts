import { describe, expect, it } from 'vitest';
import { DEFAULT_STOP_VALUES, RUNTIME_ABORT_BUDGET_MS, RUNTIME_TEARDOWN_BUDGET_MS, runtimeMaxCloseMs } from '@momonga/foundation';
import { BUSY_WAIT_LIMIT_MS } from '@momonga/foundation/sqlite';
import { LOCK_WAIT_DEADLINE_MS } from '@momonga/supervisor';
import { proofArith } from '../support/proofs/arith.ts';
import type { ProofArith } from '../support/proofs/arith.ts';
import { expectRefuted, prove } from '../support/proofs/prove.ts';
import { SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS, useZ3 } from '../harness.ts';

const HEARTBEAT_DIVISOR = 3n;
const DEFAULT_LEASE_MS = 30_000;

const satisfiable = async (arith: ProofArith): Promise<boolean> => {
  const solver = new arith.ctx.Solver();
  solver.add(...arith.assertions());
  return (await solver.check()) === 'sat';
};

describe('HB8: the database wait and the lease, the lock wait and the previous close', () => {
  const z3 = useZ3();

  it('reads today the constants the proofs start from', () => {
    expect(BUSY_WAIT_LIMIT_MS).toBe(5000);
    expect(LOCK_WAIT_DEADLINE_MS).toBe(14_000);
    expect(RUNTIME_ABORT_BUDGET_MS + RUNTIME_TEARDOWN_BUDGET_MS).toBe(18_050);
    expect(DEFAULT_LEASE_MS / Number(HEARTBEAT_DIVISOR)).toBe(10_000);
  });

  it(
    'L1 proves busy = min(5000, heartbeat(leaseMs)) never exceeds a heartbeat or 5000 ms, leaves a whole heartbeat interval of the lease unused, and is 5000 ms at the default lease, for every leaseMs >= 3',
    async () => {
      const arith = proofArith(z3.engine().api, 'L1');
      const lease = arith.int('leaseMs');
      arith.given(lease.ge(3));
      const heartbeat = arith.floorDiv(lease, HEARTBEAT_DIVISOR);
      const busy = arith.min(arith.ctx.Int.val(BigInt(BUSY_WAIT_LIMIT_MS)), heartbeat);
      const { ctx } = arith;
      expect(await satisfiable(arith)).toBe(true);
      const goal = ctx.And(
        busy.le(heartbeat),
        busy.le(BUSY_WAIT_LIMIT_MS),
        heartbeat.add(busy).le(lease.sub(heartbeat)),
        ctx.Implies(lease.eq(DEFAULT_LEASE_MS), busy.eq(BUSY_WAIT_LIMIT_MS)),
      );
      expect(await prove(arith, goal)).toEqual({ status: 'proved' });
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  it(
    'L1w refutes busy <= heartbeat for the fixed 5000 ms of today, with a lease below 15000 ms as the counter-example',
    async () => {
      const arith = proofArith(z3.engine().api, 'L1w');
      const lease = arith.int('leaseMs');
      arith.given(lease.ge(3));
      const heartbeat = arith.floorDiv(lease, HEARTBEAT_DIVISOR);
      const busy = arith.ctx.Int.val(BigInt(BUSY_WAIT_LIMIT_MS));
      const model = await expectRefuted(arith, busy.le(heartbeat));
      expect(BigInt(model.leaseMs as string)).toBeLessThan(15_000n);
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  it(
    'L2 proves that the previous generation closes in at least 15000 ms for every drain timeout d >= 0, so no lock wait below 15000 ms is sound',
    async () => {
      const arith = proofArith(z3.engine().api, 'L2');
      const drain = arith.int('d');
      arith.given(drain.ge(0));
      const close = drain.add(RUNTIME_ABORT_BUDGET_MS).add(RUNTIME_TEARDOWN_BUDGET_MS);
      expect(runtimeMaxCloseMs({ ...DEFAULT_STOP_VALUES, drainTimeoutMs: 0, mcpCloseGraceMs: 0 })).toBe(28_175);
      expect(runtimeMaxCloseMs({ ...DEFAULT_STOP_VALUES, drainTimeoutMs: 7, mcpCloseGraceMs: 0 })).toBe(28_182);
      expect(await satisfiable(arith)).toBe(true);
      expect(await prove(arith, close.ge(15_000))).toEqual({ status: 'proved' });
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  it(
    'L2w refutes that the lock wait of 14000 ms covers the close of the previous generation, with the shortest drain d = 0 as the counter-example',
    async () => {
      const arith = proofArith(z3.engine().api, 'L2w');
      const drain = arith.int('d');
      arith.given(drain.ge(0));
      const close = drain.add(RUNTIME_ABORT_BUDGET_MS).add(RUNTIME_TEARDOWN_BUDGET_MS);
      const model = await expectRefuted(arith, close.le(LOCK_WAIT_DEADLINE_MS));
      expect(BigInt(model.d as string)).toBeGreaterThanOrEqual(0n);
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );
});
