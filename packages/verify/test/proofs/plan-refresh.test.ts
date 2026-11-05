import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { GATEWAY_CONFIG_DEFAULTS } from '@momonga/gateway';
import { proofArith } from '../../src/proofs/arith.ts';
import type { ProofArith, ProofInt } from '../../src/proofs/arith.ts';
import { expectRefuted, prove } from '../../src/proofs/prove.ts';
import { SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS, useZ3 } from '../harness.ts';
import { hypothesesSatisfiable } from './budget-model.ts';

type RetryDefaults = { totalWaitMs: number; baseMs: number; maxMs: number; maxAttempts: number };

const retry = (): RetryDefaults => GATEWAY_CONFIG_DEFAULTS.retry as unknown as RetryDefaults;

const PLAN = {
  accessLifetimeMs: 3_600_000,
  attemptTimeoutMs: 15_000,
  revocationTimeoutMs: 10_000,
  skewMs: 60_000,
  refreshBudgetMs: 60_000,
  marginMs: 120_000,
  authorizationWaitMs: 300_000,
  attemptTtlMs: 315_000,
  revocationBudgetMs: 31_500,
  persistRetryMs: 30_000,
} as const;

const backoffSumMs = (attempts: number, baseMs: number, maxMs: number): number => {
  let total = 0;
  for (let index = 0; index < attempts - 1; index += 1) total += Math.min(baseMs * 2 ** index, maxMs);
  return total;
};

const authorizeSource = path.resolve(import.meta.dirname, '..', '..', '..', 'mcp', 'src', 'authorize.ts');

const authorizationWaitMs = (): number => {
  const match = /export const AUTHORIZATION_WAIT_MS = ([\d_]+);/.exec(fs.readFileSync(authorizeSource, 'utf8'));
  if (match === null) throw new Error('AUTHORIZATION_WAIT_MS is not declared in packages/mcp/src/authorize.ts');
  return Number((match[1] as string).replaceAll('_', ''));
};

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
    expect(authorizationWaitMs()).toBe(PLAN.authorizationWaitMs);
  });

  it(
    'P1 proves the refresh budget B covers every attempt timeout and the backoff between attempts',
    async () => {
      const arith = proofArith(z3.engine().api, 'P1');
      const attempts = constant(arith, 'attempts', retry().maxAttempts);
      const timeout = constant(arith, 'T_a', PLAN.attemptTimeoutMs);
      const budget = constant(arith, 'B', PLAN.refreshBudgetMs);
      const waits = backoffSum(arith, retry().maxAttempts);
      const worst = arith.int('worst');
      arith.given(worst.eq(attempts.mul(timeout).add(waits)));
      expect(await hypothesesSatisfiable(arith)).toBe(true);
      expect(await prove(arith, arith.ctx.And(worst.eq(arith.ctx.Int.val(46_500n)), worst.le(budget)))).toEqual({ status: 'proved' });
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  it(
    'P1w refutes it for an attempt timeout of 20 s, so T_a = 15 s is below the largest timeout the budget admits (19.5 s)',
    async () => {
      const arith = proofArith(z3.engine().api, 'P1w');
      const attempts = constant(arith, 'attempts', retry().maxAttempts);
      const timeout = constant(arith, 'T_a', 20_000);
      const budget = constant(arith, 'B', PLAN.refreshBudgetMs);
      const waits = backoffSum(arith, retry().maxAttempts);
      expect(await hypothesesSatisfiable(arith)).toBe(true);
      await expectRefuted(arith, attempts.mul(timeout).add(waits).le(budget));
      const largest = arith.int('largest');
      arith.given(largest.mul(attempts).add(waits).le(budget), largest.add(1).mul(attempts).add(waits).gt(budget));
      expect(await prove(arith, largest.eq(arith.ctx.Int.val(19_500n)))).toEqual({ status: 'proved' });
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
      expect(await prove(arith, arith.ctx.And(margin.lt(lifetime), period.gt(budget), period.eq(arith.ctx.Int.val(3_480_000n))))).toEqual({ status: 'proved' });
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  it(
    'P4 proves two refreshes of one account start at least L - M apart, whatever the response times',
    async () => {
      const arith = proofArith(z3.engine().api, 'P4');
      const lifetime = constant(arith, 'L', PLAN.accessLifetimeMs);
      const budget = constant(arith, 'B', PLAN.refreshBudgetMs);
      const margin = constant(arith, 'M', PLAN.marginMs);
      const firstStart = arith.int('firstStart');
      const firstEnd = arith.int('firstEnd');
      const secondStart = arith.int('secondStart');
      arith.given(firstEnd.ge(firstStart), firstEnd.le(firstStart.add(budget)), secondStart.ge(firstEnd.add(lifetime).sub(margin)));
      expect(await hypothesesSatisfiable(arith)).toBe(true);
      expect(await prove(arith, secondStart.sub(firstStart).ge(lifetime.sub(margin)))).toEqual({ status: 'proved' });
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  const scheduleArith = (name: string) => {
    const arith = proofArith(z3.engine().api, name);
    const skew = constant(arith, 'S', PLAN.skewMs);
    const margin = constant(arith, 'M', PLAN.marginMs);
    const expiresAt = arith.int('expiresAt');
    const earliest = arith.int('earliestRefreshAt');
    const defaultTime = expiresAt.sub(margin);
    const latest = expiresAt.sub(skew);
    const candidate = arith.max(defaultTime, earliest);
    return { arith, skew, expiresAt, earliest, defaultTime, latest, candidate };
  };

  it(
    'P5 proves the scheduled time with any earliest_refresh_at lies in [expiresAt - M, expiresAt - S], and equals expiresAt - M when the field is ignored',
    async () => {
      const { arith, defaultTime, latest, candidate, earliest } = scheduleArith('P5');
      const { ctx } = arith;
      const scheduled = arith.int('scheduled');
      const ignored = arith.int('ignored');
      arith.given(
        ignored.eq(ctx.If(candidate.le(latest), ctx.Int.val(0), ctx.Int.val(1)) as ProofInt),
        scheduled.eq(ctx.If(candidate.le(latest), candidate, defaultTime) as ProofInt),
      );
      expect(await hypothesesSatisfiable(arith)).toBe(true);
      expect(await prove(arith, ctx.And(scheduled.ge(defaultTime), scheduled.le(latest), ctx.Implies(ignored.eq(1), scheduled.eq(defaultTime)), ctx.Implies(earliest.le(defaultTime), scheduled.eq(defaultTime))))).toEqual({
        status: 'proved',
      });
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  it(
    'P5w refutes scheduled <= expiresAt - S when the closed-window rule is dropped and max(expiresAt - M, earliest_refresh_at) is used as is',
    async () => {
      const { arith, latest, candidate } = scheduleArith('P5w');
      expect(await hypothesesSatisfiable(arith)).toBe(true);
      await expectRefuted(arith, candidate.le(latest));
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  it(
    'P5x shows the margin guarantee of P2 does not extend to an earliest_refresh_at inside the window: a refresh scheduled there and taking B can end with less than S left',
    async () => {
      const { arith, skew, expiresAt, latest, candidate } = scheduleArith('P5x');
      const budget = constant(arith, 'B', PLAN.refreshBudgetMs);
      arith.given(candidate.le(latest));
      expect(await hypothesesSatisfiable(arith)).toBe(true);
      await expectRefuted(arith, expiresAt.sub(candidate.add(budget)).ge(skew));
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  it(
    'P5y proves the guarantee of P2 holds for every earliest_refresh_at not later than expiresAt - M',
    async () => {
      const { arith, skew, expiresAt, earliest, defaultTime, candidate } = scheduleArith('P5y');
      const budget = constant(arith, 'B', PLAN.refreshBudgetMs);
      arith.given(earliest.le(defaultTime));
      expect(await hypothesesSatisfiable(arith)).toBe(true);
      expect(await prove(arith, expiresAt.sub(candidate.add(budget)).ge(skew))).toEqual({ status: 'proved' });
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
      expect(await prove(arith, arith.ctx.And(budget.eq(attempts.mul(timeout).add(waits)), signOutWait.eq(arith.ctx.Int.val(91_500n))))).toEqual({ status: 'proved' });
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
      const ttl = constant(arith, 'ttl', PLAN.attemptTtlMs);
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
