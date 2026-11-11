import { describe, expect, it } from 'vitest';
import { AUTHORIZATION_WAIT_MS } from '@momonga/foundation';
import { GATEWAY_CONFIG_DEFAULTS, PLAN_SESSION_DEFAULTS, lazyRefreshMarginMs } from '@momonga/gateway';
import { proofArith } from '../support/proofs/arith.ts';
import type { ProofArith, ProofInt } from '../support/proofs/arith.ts';
import { expectRefuted, prove } from '../support/proofs/prove.ts';
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
    'P4 proves that when expires_in > M, two lazy refreshes of one account start at least expires_in - M apart (3479 s for expires_in = 3600 s): the adopted token expires expires_in after the response, and a lazy refresh starts only when at most M remains',
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

  const spacingArith = (name: string) => {
    const arith = proofArith(z3.engine().api, name);
    const skew = constant(arith, 'S', PLAN.skewMs);
    const margin = constant(arith, 'M', PLAN.marginMs);
    const longest = constant(arith, 'L', PLAN.accessLifetimeMs);
    const lifetime = arith.int('lifetime');
    arith.given(lifetime.ge(1), lifetime.le(longest));
    const lazyMargin = arith.min(margin, arith.max(skew, arith.floorDiv(lifetime, 2n)));
    return { arith, skew, margin, longest, lifetime, lazyMargin };
  };

  it(
    'R1 proves that for every lifetime in [1, L] the lazy margin min(M, max(S, floor(lifetime / 2))) lies in [S, M], and equals M for the lifetime L',
    async () => {
      const { arith, skew, margin, longest, lifetime, lazyMargin } = spacingArith('R1');
      expect(await hypothesesSatisfiable(arith)).toBe(true);
      expect(await prove(arith, arith.ctx.And(lazyMargin.ge(skew), lazyMargin.le(margin)))).toEqual({ status: 'proved' });
      arith.given(lifetime.eq(longest));
      expect(await prove(arith, lazyMargin.eq(margin))).toEqual({ status: 'proved' });
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  it("the product's lazy margin is the proven formula", () => {
    const skew = PLAN.skewMs;
    const margin = PLAN.marginMs;
    const lifetimes = [1, skew - 1, skew, 2 * skew - 1, 2 * skew, 2 * skew + 1, 2 * margin - 1, 2 * margin, 2 * margin + 1, PLAN.accessLifetimeMs];
    const proven = (lifetime: number): number => Math.min(margin, Math.max(skew, Math.floor(lifetime / 2)));
    expect(lifetimes.map((lifetime) => [lifetime, lazyRefreshMarginMs(lifetime)])).toEqual(lifetimes.map((lifetime) => [lifetime, proven(lifetime)]));
  });

  it(
    'R2 proves that two lazy refreshes of one account start at least S apart whatever lifetime the endpoint issues: the second starts only when at most the lazy margin remains and the token adopted by the first is at least S old',
    async () => {
      const { arith, skew, lifetime, lazyMargin } = spacingArith('R2');
      const budget = constant(arith, 'B', PLAN.refreshBudgetMs);
      const firstStart = arith.int('firstStart');
      const issuedAt = arith.int('issuedAt');
      const secondStart = arith.int('secondStart');
      arith.given(issuedAt.ge(firstStart), issuedAt.le(firstStart.add(budget)));
      arith.given(secondStart.ge(issuedAt), issuedAt.add(lifetime).sub(secondStart).le(lazyMargin), secondStart.sub(issuedAt).ge(skew));
      expect(await hypothesesSatisfiable(arith)).toBe(true);
      expect(await prove(arith, secondStart.sub(firstStart).ge(skew))).toEqual({ status: 'proved' });
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  it(
    'R2m proves that for a lifetime of at least 2S the margin alone already makes the token S old when a lazy refresh starts, so the age condition changes nothing there',
    async () => {
      const { arith, skew, lifetime, lazyMargin } = spacingArith('R2m');
      const issuedAt = arith.int('issuedAt');
      const start = arith.int('start');
      arith.given(lifetime.ge(skew.mul(2)), start.ge(issuedAt), issuedAt.add(lifetime).sub(start).le(lazyMargin));
      expect(await hypothesesSatisfiable(arith)).toBe(true);
      expect(await prove(arith, start.sub(issuedAt).ge(skew))).toEqual({ status: 'proved' });
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  it(
    'R2w refutes the spacing without the age condition: with a lifetime of at most M and the margin M, the next lazy refresh can start at once',
    async () => {
      const arith = proofArith(z3.engine().api, 'R2w');
      const skew = constant(arith, 'S', PLAN.skewMs);
      const margin = constant(arith, 'M', PLAN.marginMs);
      const lifetime = arith.int('lifetime');
      const issuedAt = arith.int('issuedAt');
      const secondStart = arith.int('secondStart');
      arith.given(lifetime.ge(1), lifetime.le(margin), secondStart.ge(issuedAt), issuedAt.add(lifetime).sub(secondStart).le(margin));
      expect(await hypothesesSatisfiable(arith)).toBe(true);
      await expectRefuted(arith, secondStart.sub(issuedAt).ge(skew));
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  it(
    'R3 proves that two forced refreshes of one account start at least S apart: a 401 starts one only when the rejected token is at least S old',
    async () => {
      const arith = proofArith(z3.engine().api, 'R3');
      const skew = constant(arith, 'S', PLAN.skewMs);
      const budget = constant(arith, 'B', PLAN.refreshBudgetMs);
      const firstStart = arith.int('firstStart');
      const issuedAt = arith.int('issuedAt');
      const secondStart = arith.int('secondStart');
      arith.given(issuedAt.ge(firstStart), issuedAt.le(firstStart.add(budget)), secondStart.sub(issuedAt).ge(skew));
      expect(await hypothesesSatisfiable(arith)).toBe(true);
      expect(await prove(arith, secondStart.sub(firstStart).ge(skew))).toEqual({ status: 'proved' });
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  it(
    'R3w refutes it for a forced refresh without the age condition: it can start on a 401 at once',
    async () => {
      const arith = proofArith(z3.engine().api, 'R3w');
      const skew = constant(arith, 'S', PLAN.skewMs);
      const budget = constant(arith, 'B', PLAN.refreshBudgetMs);
      const firstStart = arith.int('firstStart');
      const issuedAt = arith.int('issuedAt');
      const secondStart = arith.int('secondStart');
      arith.given(issuedAt.ge(firstStart), issuedAt.le(firstStart.add(budget)), secondStart.ge(issuedAt));
      expect(await hypothesesSatisfiable(arith)).toBe(true);
      await expectRefuted(arith, secondStart.sub(firstStart).ge(skew));
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
