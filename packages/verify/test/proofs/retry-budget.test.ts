import { describe, expect, it } from 'vitest';
import { GATEWAY_CONFIG_DEFAULTS } from '@momonga/gateway';
import { proofArith } from '../../src/proofs/arith.ts';
import type { ProofArith, ProofInt } from '../../src/proofs/arith.ts';
import { expectRefuted, prove } from '../../src/proofs/prove.ts';
import { SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS, useZ3 } from '../harness.ts';

type RetryDefaults = { totalWaitMs: number; baseMs: number; maxMs: number; maxAttempts: number };

const retry = (): RetryDefaults => GATEWAY_CONFIG_DEFAULTS.retry as unknown as RetryDefaults;

const DECIDED_TOTAL_WAIT_MS = 84_000;
const DOUBLINGS_UNTIL_MAX = 4;
const HALF_CAPS_BEFORE_MAX_MS = 250 + 500 + 1000 + 2000;
const MAX_WAITS = DOUBLINGS_UNTIL_MAX + Math.floor((2 * (DECIDED_TOTAL_WAIT_MS - HALF_CAPS_BEFORE_MAX_MS)) / 8000);
const MAX_SENDS = MAX_WAITS + 1;

const doublingsUntilMax = (baseMs: bigint, maxMs: bigint): bigint => {
  let doublings = 0n;
  while (baseMs * 2n ** doublings < maxMs) doublings += 1n;
  return doublings;
};

const halfCapsBeforeMax = (baseMs: bigint, doublings: bigint): bigint => {
  let total = 0n;
  for (let index = 0n; index < doublings; index += 1n) total += (baseMs * 2n ** index) / 2n;
  return total;
};

const waitsBound = (totalWaitMs: bigint, baseMs: bigint, maxMs: bigint): bigint => {
  const doublings = doublingsUntilMax(baseMs, maxMs);
  return doublings + (2n * (totalWaitMs - halfCapsBeforeMax(baseMs, doublings))) / maxMs;
};

const budgetOf = (arith: ProofArith): { total: ProofInt } => {
  const total = arith.int('totalWaitMs');
  arith.given(total.eq(arith.ctx.Int.val(BigInt(retry().totalWaitMs))));
  return { total };
};

const satisfiable = async (arith: ProofArith): Promise<boolean> => {
  const solver = new arith.ctx.Solver();
  solver.add(...arith.assertions());
  return (await solver.check()) === 'sat';
};

describe('item 11: the gateway retry budget', () => {
  const z3 = useZ3();

  it('reads the decided default budget of 84 s with base 500 ms and max 8 s', () => {
    expect(retry()).toMatchObject({ totalWaitMs: DECIDED_TOTAL_WAIT_MS, baseMs: 500, maxMs: 8000 });
  });

  it('derives the sends bound 4 + floor(2 (84000 - 3750) / 8000) = 24 waits, so at most 25 sends', () => {
    expect(MAX_WAITS).toBe(24);
    expect(MAX_SENDS).toBe(25);
    const { totalWaitMs, baseMs, maxMs } = retry();
    expect(waitsBound(BigInt(totalWaitMs), BigInt(baseMs), BigInt(maxMs))).toBe(BigInt(MAX_WAITS));
  });

  it(
    'R1 proves waited + wait <= totalWaitMs after every retry the elapsed rule admits, for any send durations',
    async () => {
      const arith = proofArith(z3.engine().api, 'R1');
      const { total } = budgetOf(arith);
      const waited = arith.int('waited');
      const elapsed = arith.int('elapsed');
      const send = arith.int('send');
      const wait = arith.int('wait');
      arith.given(waited.ge(0), elapsed.ge(waited), elapsed.le(total), send.ge(0), wait.ge(0), elapsed.add(send).add(wait).le(total));
      expect(await satisfiable(arith)).toBe(true);
      const goal = arith.ctx.And(waited.add(wait).le(total), elapsed.add(send).add(wait).le(total));
      expect(await prove(arith, goal)).toEqual({ status: 'proved' });
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  it(
    'R1w refutes waited + wait <= totalWaitMs under the old per-wait rule wait <= maxMs without the budget guard',
    async () => {
      const arith = proofArith(z3.engine().api, 'R1w');
      const { total } = budgetOf(arith);
      const waited = arith.int('waited');
      const wait = arith.int('wait');
      arith.given(waited.ge(0), waited.le(total), wait.ge(0), wait.le(arith.ctx.Int.val(BigInt(retry().maxMs))));
      expect(await satisfiable(arith)).toBe(true);
      const model = await expectRefuted(arith, waited.add(wait).le(total));
      expect(BigInt(model.waited as string) + BigInt(model.wait as string)).toBeGreaterThan(BigInt(retry().totalWaitMs));
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  it(
    'R2 proves every honoured Retry-After is at most the remaining budget totalWaitMs - elapsed',
    async () => {
      const arith = proofArith(z3.engine().api, 'R2');
      const { total } = budgetOf(arith);
      const elapsed = arith.int('elapsed');
      const send = arith.int('send');
      const backoff = arith.int('backoff');
      const retryAfter = arith.int('retryAfter');
      const wait = arith.max(backoff, retryAfter);
      arith.given(elapsed.ge(0), elapsed.le(total), send.ge(0), backoff.ge(0), retryAfter.ge(0), elapsed.add(send).add(wait).le(total));
      expect(await satisfiable(arith)).toBe(true);
      expect(await prove(arith, retryAfter.le(total.sub(elapsed.add(send))))).toEqual({ status: 'proved' });
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  it(
    'R2w refutes it when a Retry-After is honoured whenever it is at most maxMs, without the budget guard',
    async () => {
      const arith = proofArith(z3.engine().api, 'R2w');
      const { total } = budgetOf(arith);
      const elapsed = arith.int('elapsed');
      const retryAfter = arith.int('retryAfter');
      arith.given(elapsed.ge(0), elapsed.le(total), retryAfter.ge(0), retryAfter.le(arith.ctx.Int.val(BigInt(retry().maxMs))));
      expect(await satisfiable(arith)).toBe(true);
      await expectRefuted(arith, retryAfter.le(total.sub(elapsed)));
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  const tailArith = (name: string, minimumTwiceWait: bigint) => {
    const arith = proofArith(z3.engine().api, name);
    const { total } = budgetOf(arith);
    const { baseMs, maxMs } = retry();
    const doublings = doublingsUntilMax(BigInt(baseMs), BigInt(maxMs));
    const prefix = halfCapsBeforeMax(BigInt(baseMs), doublings);
    const waits = arith.int('waits');
    const waited = arith.int('waited');
    const wait = arith.int('wait');
    const { ctx } = arith;
    const invariant = (count: ProofInt, sum: ProofInt) =>
      ctx.Implies(count.ge(ctx.Int.val(doublings)), sum.mul(2).ge(ctx.Int.val(2n * prefix).add(count.sub(ctx.Int.val(doublings)).mul(ctx.Int.val(BigInt(maxMs))))));
    arith.given(waits.ge(ctx.Int.val(doublings)), waited.ge(0), wait.mul(2).ge(ctx.Int.val(minimumTwiceWait)), invariant(waits, waited));
    return { arith, total, waits, waited, wait, invariant, doublings, prefix, maxMs: BigInt(maxMs) };
  };

  it(
    'R3a proves the equal-jitter lower bound 2 waited >= 2 S_K + (n - K) maxMs is kept by every wait of at least maxMs / 2 after K doublings',
    async () => {
      const { arith, waits, waited, wait, invariant } = tailArith('R3a', BigInt(retry().maxMs));
      expect(await satisfiable(arith)).toBe(true);
      expect(await prove(arith, invariant(waits.add(1), waited.add(wait)))).toEqual({ status: 'proved' });
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  it(
    'R3base proves the first K waits, each at least half its cap, sum to at least S_K',
    async () => {
      const arith = proofArith(z3.engine().api, 'R3base');
      const { baseMs, maxMs: max } = retry();
      const doublings = doublingsUntilMax(BigInt(baseMs), BigInt(max));
      const { ctx } = arith;
      const waits = Array.from({ length: Number(doublings) }, (_unused, index) => {
        const wait = arith.int(`wait${index}`);
        arith.given(wait.mul(2).ge(ctx.Int.val(BigInt(baseMs) * 2n ** BigInt(index))));
        return wait;
      });
      const waited = waits.reduce((total: ProofInt, wait) => total.add(wait), ctx.Int.val(0n));
      expect(await satisfiable(arith)).toBe(true);
      expect(await prove(arith, waited.ge(ctx.Int.val(halfCapsBeforeMax(BigInt(baseMs), doublings))))).toEqual({ status: 'proved' });
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  it(
    'R3b proves the number of waits within the budget is at most K + floor(2 (totalWaitMs - S_K) / maxMs)',
    async () => {
      const { arith, total, waits, waited, doublings, prefix, maxMs: maxWaitMs } = tailArith('R3b', maxMs());
      arith.given(waited.le(total));
      const bound = arith.ctx.Int.val(doublings).add(arith.floorDiv(total.sub(arith.ctx.Int.val(prefix)).mul(2), maxWaitMs));
      expect(await satisfiable(arith)).toBe(true);
      expect(await prove(arith, waits.le(bound))).toEqual({ status: 'proved' });
      expect(await prove(arith, waits.add(1).le(arith.ctx.Int.val(BigInt(MAX_SENDS))))).toEqual({ status: 'proved' });
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  const spreadArith = (name: string, perEarlierTargetCap: bigint) => {
    const arith = proofArith(z3.engine().api, name);
    const { ctx } = arith;
    const attempts = ctx.Int.val(BigInt(retry().maxAttempts));
    const candidates = arith.int('candidates');
    const left = arith.int('earlierTargets');
    const earlier = arith.int('earlierSends');
    const here = arith.int('sendsHere');
    const last = arith.int('lastTargetSends');
    arith.given(
      candidates.ge(1),
      left.ge(0),
      left.lt(candidates.sub(1)),
      earlier.ge(0),
      earlier.le(left.mul(attempts)),
      here.ge(1),
      here.le(ctx.Int.val(perEarlierTargetCap)),
      last.ge(1),
      last.le(ctx.Int.val(BigInt(MAX_SENDS))),
    );
    return { arith, ctx, attempts, candidates, left, earlier, here, last };
  };

  it(
    'R4 proves at most (C - 1) maxAttempts + 25 sends across C candidates: each earlier target is capped at maxAttempts and the last uses at most the single-target bound',
    async () => {
      const { arith, ctx, attempts, candidates, left, earlier, here, last } = spreadArith('R4', BigInt(retry().maxAttempts));
      expect(await satisfiable(arith)).toBe(true);
      expect(await prove(arith, earlier.add(here).le(left.add(1).mul(attempts)))).toEqual({ status: 'proved' });
      const total = earlier.add(here).add(last);
      const bound = candidates.sub(1).mul(attempts).add(ctx.Int.val(BigInt(MAX_SENDS)));
      expect(await prove(arith, total.le(bound))).toEqual({ status: 'proved' });
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  it(
    'R4w refutes the multi-target bound when an earlier target may also use the single-target bound instead of maxAttempts',
    async () => {
      const { arith, ctx, attempts, candidates, left, earlier, here, last } = spreadArith('R4w', BigInt(MAX_SENDS));
      expect(await satisfiable(arith)).toBe(true);
      const total = earlier.add(here).add(last);
      const bound = candidates.sub(1).mul(attempts).add(ctx.Int.val(BigInt(MAX_SENDS)));
      const model = await expectRefuted(arith, total.le(bound));
      expect(BigInt(model.sendsHere as string)).toBeGreaterThan(BigInt(retry().maxAttempts));
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  it(
    'R3w refutes the sends bound under full jitter, where a wait can be 0',
    async () => {
      const arith = proofArith(z3.engine().api, 'R3w');
      const { total } = budgetOf(arith);
      const waits = arith.int('waits');
      const waited = arith.int('waited');
      arith.given(waits.ge(0), waited.ge(0), waited.le(total));
      expect(await satisfiable(arith)).toBe(true);
      const model = await expectRefuted(arith, waits.add(1).le(arith.ctx.Int.val(BigInt(MAX_SENDS))));
      expect(BigInt(model.waits as string) + 1n).toBeGreaterThan(BigInt(MAX_SENDS));
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );
});

const maxMs = (): bigint => BigInt(retry().maxMs);
