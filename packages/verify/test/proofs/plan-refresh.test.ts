import { describe, expect, it } from 'vitest';
import { AUTHORIZATION_WAIT_MS } from '@momonga/foundation';
import { GATEWAY_CONFIG_DEFAULTS, PLAN_SESSION_DEFAULTS } from '@momonga/gateway';
import { proofArith } from '../../src/proofs/arith.ts';
import type { ProofArith, ProofInt } from '../../src/proofs/arith.ts';
import { expectRefuted, prove } from '../../src/proofs/prove.ts';
import { SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS, useZ3 } from '../harness.ts';
import { hypothesesSatisfiable } from './budget-model.ts';

type RetryDefaults = { totalWaitMs: number; baseMs: number; maxMs: number; maxAttempts: number };

const retry = (): RetryDefaults => GATEWAY_CONFIG_DEFAULTS.retry as unknown as RetryDefaults;

const PLAN = PLAN_SESSION_DEFAULTS;

const ATTEMPT_TTL_MS = 315_000;

const backoffSumMs = (attempts: number, baseMs: number, maxMs: number): number => {
  let total = 0;
  for (let index = 0; index < attempts - 1; index += 1) total += Math.min(baseMs * 2 ** index, maxMs);
  return total;
};

const authorizationWaitMs = (): number => AUTHORIZATION_WAIT_MS;

const constant = (arith: ProofArith, name: string, value: number): ProofInt => {
  const variable = arith.int(name);
  arith.given(variable.eq(arith.ctx.Int.val(BigInt(value))));
  return variable;
};

const backoffSum = (arith: ProofArith, attempts: number): ProofInt => {
  const { baseMs, maxMs } = retry();
  const cap = arith.ctx.Int.val(BigInt(maxMs));
  let total: ProofInt = arith.ctx.Int.val(0n);
  for (let index = 0; index < attempts - 1; index += 1) total = total.add(arith.min(arith.ctx.Int.val(BigInt(baseMs * 2 ** index)), cap));
  return total;
};

describe('the plan credential numbers of design-chatgpt-plan.md section 6', () => {
  const z3 = useZ3();

  it('reads the gateway retry policy the derivations rest on and the 30 s persist retry equal to the breaker open time', () => {
    expect(retry()).toMatchObject({ maxAttempts: 3, baseMs: 500, maxMs: 8000 });
    expect(backoffSumMs(retry().maxAttempts, retry().baseMs, retry().maxMs)).toBe(1500);
    expect(PLAN.persistRetryMs).toBe(GATEWAY_CONFIG_DEFAULTS.breaker.openMs);
  });

  it('keeps the authorization wait of the plan sign-in equal to the constant of the MCP authorization', () => {
    expect(authorizationWaitMs()).toBe(300_000);
  });

  const waitCapArith = (name: string, budgetMs: number, capMs: number) => {
    const arith = proofArith(z3.engine().api, name);
    const attempts = constant(arith, 'attempts', retry().maxAttempts);
    const timeout = constant(arith, 'T_a', PLAN.attemptTimeoutMs);
    const budget = constant(arith, 'B', budgetMs);
    const cap = constant(arith, 'C', capMs);
    const { baseMs, maxMs } = retry();
    const ceiling = arith.ctx.Int.val(BigInt(maxMs));
    let waited: ProofInt = arith.ctx.Int.val(0n);
    for (let index = 0; index < retry().maxAttempts - 1; index += 1) {
      const backoff = arith.min(arith.ctx.Int.val(BigInt(baseMs * 2 ** index)), ceiling);
      const retryAfter = arith.int(`retryAfter${index}`);
      arith.given(retryAfter.ge(0));
      const wait = arith.int(`wait${index}`);
      arith.given(wait.eq(arith.max(backoff, arith.min(retryAfter, cap))));
      waited = waited.add(wait);
    }
    return { arith, attempts, timeout, budget, cap, waited };
  };

  it(
    'P1 proves that with the Retry-After cap C = retry.maxMs = 8 s every wait of nextWait is at most C, so a refresh lasts at most attempts x T_a + (attempts - 1) x C, and that this is exactly B = 61 s: B is derived, not chosen',
    async () => {
      const { arith, attempts, timeout, budget, cap, waited } = waitCapArith('P1', PLAN.refreshBudgetMs, retry().maxMs);
      const worst = arith.int('worst');
      arith.given(worst.eq(attempts.mul(timeout).add(cap.mul(attempts.sub(1)))));
      expect(await hypothesesSatisfiable(arith)).toBe(true);
      expect(await prove(arith, arith.ctx.And(cap.eq(arith.ctx.Int.val(BigInt(retry().maxMs))), waited.le(cap.mul(attempts.sub(1))), attempts.mul(timeout).add(waited).le(budget), worst.eq(budget), budget.eq(arith.ctx.Int.val(61_000n))))).toEqual({ status: 'proved' });
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  it(
    'P1b refutes B = 60 s, the value of revision 3: with the cap at retry.maxMs, a refresh can last 61 s',
    async () => {
      const { arith, attempts, timeout, budget, waited } = waitCapArith('P1b', 60_000, retry().maxMs);
      expect(await hypothesesSatisfiable(arith)).toBe(true);
      await expectRefuted(arith, attempts.mul(timeout).add(waited).le(budget));
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  it(
    'P1w refutes it for an attempt timeout of 20 s, so T_a = 15 s is the largest timeout the budget admits',
    async () => {
      const arith = proofArith(z3.engine().api, 'P1w');
      const attempts = constant(arith, 'attempts', retry().maxAttempts);
      const timeout = constant(arith, 'T_a', 20_000);
      const budget = constant(arith, 'B', PLAN.refreshBudgetMs);
      const cap = constant(arith, 'C', retry().maxMs);
      expect(await hypothesesSatisfiable(arith)).toBe(true);
      await expectRefuted(arith, attempts.mul(timeout).add(cap.mul(attempts.sub(1))).le(budget));
      const largest = arith.int('largest');
      arith.given(largest.mul(attempts).add(cap.mul(attempts.sub(1))).le(budget), largest.add(1).mul(attempts).add(cap.mul(attempts.sub(1))).gt(budget));
      expect(await prove(arith, largest.eq(arith.ctx.Int.val(15_000n)))).toEqual({ status: 'proved' });
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  it(
    'P1u refutes B for a Retry-After honoured without a cap',
    async () => {
      const { arith, attempts, timeout, budget, waited } = waitCapArith('P1u', PLAN.refreshBudgetMs, 3_600_000);
      expect(await hypothesesSatisfiable(arith)).toBe(true);
      await expectRefuted(arith, attempts.mul(timeout).add(waited).le(budget));
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  it(
    'P2 proves M = S + B, so a refresh that starts at the margin and takes any time up to B ends with at least the skew allowance S left',
    async () => {
      const arith = proofArith(z3.engine().api, 'P2');
      const skew = constant(arith, 'S', PLAN.skewMs);
      const budget = constant(arith, 'B', PLAN.refreshBudgetMs);
      const margin = constant(arith, 'M', PLAN.marginMs);
      const duration = arith.int('duration');
      arith.given(duration.ge(0), duration.le(budget));
      expect(await hypothesesSatisfiable(arith)).toBe(true);
      expect(await prove(arith, arith.ctx.And(margin.ge(skew.add(budget)), margin.sub(duration).ge(skew)))).toEqual({ status: 'proved' });
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  it(
    'P2w refutes it for a margin equal to the skew allowance alone',
    async () => {
      const arith = proofArith(z3.engine().api, 'P2w');
      const skew = constant(arith, 'S', PLAN.skewMs);
      const budget = constant(arith, 'B', PLAN.refreshBudgetMs);
      const margin = constant(arith, 'M', PLAN.skewMs);
      const duration = arith.int('duration');
      arith.given(duration.ge(0), duration.le(budget));
      expect(await hypothesesSatisfiable(arith)).toBe(true);
      const model = await expectRefuted(arith, margin.sub(duration).ge(skew));
      expect(BigInt(model.duration as string)).toBeGreaterThan(0n);
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  it(
    'P3 proves M < L and L - M > B: a token that has just been issued is not due, and the next refresh cannot start before the previous one has ended',
    async () => {
      const arith = proofArith(z3.engine().api, 'P3');
      const lifetime = constant(arith, 'L', PLAN.accessLifetimeMs);
      const budget = constant(arith, 'B', PLAN.refreshBudgetMs);
      const margin = constant(arith, 'M', PLAN.marginMs);
      const period = arith.int('period');
      arith.given(period.eq(lifetime.sub(margin)));
      expect(await hypothesesSatisfiable(arith)).toBe(true);
      expect(await prove(arith, arith.ctx.And(margin.lt(lifetime), period.gt(budget), period.eq(arith.ctx.Int.val(3_479_000n))))).toEqual({ status: 'proved' });
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  it(
    'P4 proves that with the adoption rule expires_in > M, two lazy refreshes of one account start at least expires_in - M apart (3479 s for expires_in = 3600 s): the adopted token expires expires_in after the response, and a lazy refresh starts only when at most M remains',
    async () => {
      const arith = proofArith(z3.engine().api, 'P4');
      const lifetime = constant(arith, 'L', PLAN.accessLifetimeMs);
      const budget = constant(arith, 'B', PLAN.refreshBudgetMs);
      const margin = constant(arith, 'M', PLAN.marginMs);
      const expiresIn = arith.int('expiresIn');
      const firstStart = arith.int('firstStart');
      const firstEnd = arith.int('firstEnd');
      const expiresAt = arith.int('expiresAt');
      const secondStart = arith.int('secondStart');
      arith.given(expiresIn.gt(margin), expiresIn.le(lifetime));
      arith.given(firstEnd.ge(firstStart), firstEnd.le(firstStart.add(budget)), expiresAt.eq(firstEnd.add(expiresIn)));
      arith.given(secondStart.ge(firstEnd), expiresAt.sub(secondStart).le(margin));
      expect(await hypothesesSatisfiable(arith)).toBe(true);
      expect(await prove(arith, secondStart.sub(firstStart).ge(expiresIn.sub(margin)))).toEqual({ status: 'proved' });
      arith.given(expiresIn.eq(lifetime));
      expect(await prove(arith, secondStart.sub(firstStart).ge(arith.ctx.Int.val(3_479_000n)))).toEqual({ status: 'proved' });
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  it(
    'P4w refutes the same spacing when a response with expires_in <= M is adopted: the next lazy refresh can start at once',
    async () => {
      const arith = proofArith(z3.engine().api, 'P4w');
      const margin = constant(arith, 'M', PLAN.marginMs);
      const expiresIn = arith.int('expiresIn');
      const firstEnd = arith.int('firstEnd');
      const expiresAt = arith.int('expiresAt');
      const secondStart = arith.int('secondStart');
      arith.given(expiresIn.gt(0), expiresIn.le(margin), expiresAt.eq(firstEnd.add(expiresIn)));
      arith.given(secondStart.ge(firstEnd), expiresAt.sub(secondStart).le(margin));
      expect(await hypothesesSatisfiable(arith)).toBe(true);
      await expectRefuted(arith, secondStart.sub(firstEnd).ge(1));
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  it(
    'P4f refutes the same spacing for a forced refresh: it starts on a 401 whatever remains, so only the per-generation coalescing of the model PlanCredential bounds it',
    async () => {
      const arith = proofArith(z3.engine().api, 'P4f');
      const lifetime = constant(arith, 'L', PLAN.accessLifetimeMs);
      const budget = constant(arith, 'B', PLAN.refreshBudgetMs);
      const margin = constant(arith, 'M', PLAN.marginMs);
      const firstStart = arith.int('firstStart');
      const firstEnd = arith.int('firstEnd');
      const secondStart = arith.int('secondStart');
      arith.given(firstEnd.ge(firstStart), firstEnd.le(firstStart.add(budget)), secondStart.ge(firstEnd));
      expect(await hypothesesSatisfiable(arith)).toBe(true);
      await expectRefuted(arith, secondStart.sub(firstStart).ge(lifetime.sub(margin)));
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  it(
    'P6 proves the revocation budget 31.5 s equals attempts x T_rev plus the backoff between attempts, and the sign-out wait is at most B plus that budget',
    async () => {
      const arith = proofArith(z3.engine().api, 'P6');
      const attempts = constant(arith, 'attempts', retry().maxAttempts);
      const timeout = constant(arith, 'T_rev', PLAN.revocationTimeoutMs);
      const budget = constant(arith, 'revocationBudget', PLAN.revocationBudgetMs);
      const refreshBudget = constant(arith, 'B', PLAN.refreshBudgetMs);
      const waits = backoffSum(arith, retry().maxAttempts);
      const signOutWait = arith.int('signOutWait');
      arith.given(signOutWait.eq(refreshBudget.add(budget)));
      expect(await hypothesesSatisfiable(arith)).toBe(true);
      expect(await prove(arith, arith.ctx.And(budget.eq(attempts.mul(timeout).add(waits)), signOutWait.eq(arith.ctx.Int.val(92_500n))))).toEqual({ status: 'proved' });
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  it(
    'P6w refutes the budget for a revocation timeout one millisecond longer',
    async () => {
      const arith = proofArith(z3.engine().api, 'P6w');
      const attempts = constant(arith, 'attempts', retry().maxAttempts);
      const timeout = constant(arith, 'T_rev', PLAN.revocationTimeoutMs + 1);
      const budget = constant(arith, 'revocationBudget', PLAN.revocationBudgetMs);
      const waits = backoffSum(arith, retry().maxAttempts);
      expect(await hypothesesSatisfiable(arith)).toBe(true);
      await expectRefuted(arith, attempts.mul(timeout).add(waits).le(budget));
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  it(
    'P7 proves an attempt TTL of wait + T_a covers a callback that arrives at the end of the wait and then needs the whole exchange timeout',
    async () => {
      const arith = proofArith(z3.engine().api, 'P7');
      const wait = constant(arith, 'wait', authorizationWaitMs());
      const timeout = constant(arith, 'T_a', PLAN.attemptTimeoutMs);
      const ttl = constant(arith, 'ttl', ATTEMPT_TTL_MS);
      const begin = arith.int('begin');
      const arrival = arith.int('arrival');
      const exchange = arith.int('exchange');
      arith.given(arrival.ge(begin), arrival.le(begin.add(wait)), exchange.ge(0), exchange.le(timeout));
      expect(await hypothesesSatisfiable(arith)).toBe(true);
      expect(await prove(arith, arith.ctx.And(ttl.eq(wait.add(timeout)), arrival.add(exchange).le(begin.add(ttl))))).toEqual({ status: 'proved' });
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  it(
    'P7w refutes it for a TTL equal to the wait alone',
    async () => {
      const arith = proofArith(z3.engine().api, 'P7w');
      const wait = constant(arith, 'wait', authorizationWaitMs());
      const timeout = constant(arith, 'T_a', PLAN.attemptTimeoutMs);
      const ttl = constant(arith, 'ttl', authorizationWaitMs());
      const begin = arith.int('begin');
      const arrival = arith.int('arrival');
      const exchange = arith.int('exchange');
      arith.given(arrival.ge(begin), arrival.le(begin.add(wait)), exchange.ge(0), exchange.le(timeout));
      expect(await hypothesesSatisfiable(arith)).toBe(true);
      await expectRefuted(arith, arrival.add(exchange).le(begin.add(ttl)));
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );
});
