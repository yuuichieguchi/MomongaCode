import { describe, expect, it } from 'vitest';
import {
  CHILD_STDIO_FLUSH_MS,
  GATEWAY_MAX_CLOSE_MS,
  KILL_CONFIRM_MS,
  RUNTIME_ABORT_BUDGET_MS,
  RUNTIME_TEARDOWN_BUDGET_MS,
  SHUTDOWN_DRAIN_BOUND_MS,
  SHUTDOWN_MARGIN_MS,
  SHUTDOWN_REAP_BOUND_MS,
  SHUTDOWN_RELEASE_BOUND_MS,
  runtimeMaxCloseMs,
  supervisorMaxCloseMs,
} from '@momonga/foundation';
import { ORPHAN_REAP_GRACE_MS, STARTUP_TIMEOUT_MS } from '@momonga/supervisor';
import { proofArith } from '../../src/proofs/arith.ts';
import type { ProofArith, ProofInt } from '../../src/proofs/arith.ts';
import { expectRefuted, prove } from '../../src/proofs/prove.ts';
import { SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS, useZ3 } from '../harness.ts';

const constant = (arith: ProofArith, value: number): ProofInt => arith.ctx.Int.val(BigInt(value));

const drainTimeoutOf = (arith: ProofArith): ProofInt => {
  const drainTimeout = arith.int('drainTimeoutMs');
  arith.given(drainTimeout.ge(0));
  return drainTimeout;
};

const runtimeCloseOf = (arith: ProofArith, drainTimeout: ProofInt): ProofInt =>
  drainTimeout.add(constant(arith, RUNTIME_ABORT_BUDGET_MS)).add(constant(arith, RUNTIME_TEARDOWN_BUDGET_MS));

const stageTermsOf = (arith: ProofArith, drainTimeout: ProofInt): ReadonlyArray<readonly [name: string, term: ProofInt]> => {
  const killedChildSettle = constant(arith, KILL_CONFIRM_MS).add(constant(arith, CHILD_STDIO_FLUSH_MS));
  return [
    ['drain', constant(arith, SHUTDOWN_DRAIN_BOUND_MS)],
    ['runtimeStop', runtimeCloseOf(arith, drainTimeout).add(constant(arith, SHUTDOWN_MARGIN_MS))],
    ['runtimeKilledChildSettle', killedChildSettle],
    ['gatewayStop', constant(arith, GATEWAY_MAX_CLOSE_MS).add(constant(arith, SHUTDOWN_MARGIN_MS))],
    ['gatewayKilledChildSettle', killedChildSettle],
    ['reap', constant(arith, SHUTDOWN_REAP_BOUND_MS)],
    ['release', constant(arith, SHUTDOWN_RELEASE_BOUND_MS)],
  ];
};

const sumOf = (arith: ProofArith, terms: readonly ProofInt[]): ProofInt => terms.reduce((total, term) => total.add(term), constant(arith, 0));

const SAMPLED_DRAIN_TIMEOUTS_MS = [0, 1, 30_000, 123_456] as const;

describe('shutdown and start-up bounds (design-probe-timeout Z3 item 3)', () => {
  const z3 = useZ3();

  it('reads the closed forms of the code at sampled drain timeouts, so the proofs below describe the code and not themselves', () => {
    const fixedTerms = SHUTDOWN_DRAIN_BOUND_MS + SHUTDOWN_MARGIN_MS + 2 * (KILL_CONFIRM_MS + CHILD_STDIO_FLUSH_MS) + GATEWAY_MAX_CLOSE_MS + SHUTDOWN_MARGIN_MS + SHUTDOWN_REAP_BOUND_MS + SHUTDOWN_RELEASE_BOUND_MS;
    for (const drainTimeout of SAMPLED_DRAIN_TIMEOUTS_MS) {
      expect(runtimeMaxCloseMs(drainTimeout)).toBe(drainTimeout + RUNTIME_ABORT_BUDGET_MS + RUNTIME_TEARDOWN_BUDGET_MS);
      expect(supervisorMaxCloseMs(drainTimeout)).toBe(drainTimeout + RUNTIME_ABORT_BUDGET_MS + RUNTIME_TEARDOWN_BUDGET_MS + fixedTerms);
    }
    expect(supervisorMaxCloseMs(0)).toBe(63_000);
  });

  it('S1 proves supervisorMaxCloseMs(d) is the sum of its seven stage terms, each non-negative, and equals d + 63000 for every d >= 0', async () => {
    const arith = proofArith(z3.engine().api, 'S1');
    const drainTimeout = drainTimeoutOf(arith);
    const terms = stageTermsOf(arith, drainTimeout);
    expect(terms.map(([name]) => name)).toEqual(['drain', 'runtimeStop', 'runtimeKilledChildSettle', 'gatewayStop', 'gatewayKilledChildSettle', 'reap', 'release']);
    const total = sumOf(arith, terms.map(([, term]) => term));
    const { ctx } = arith;
    expect(await prove(arith, ctx.And(...terms.map(([, term]) => term.ge(0))))).toEqual({ status: 'proved' });
    expect(await prove(arith, total.eq(drainTimeout.add(63_000)))).toEqual({ status: 'proved' });
    for (const sample of SAMPLED_DRAIN_TIMEOUTS_MS) expect(supervisorMaxCloseMs(sample)).toBe(sample + 63_000);
  }, SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS);

  it('S1w refutes that the total is d + 61000, so the closed form of S1 is not satisfied by a wrong constant', async () => {
    const arith = proofArith(z3.engine().api, 'S1w');
    const drainTimeout = drainTimeoutOf(arith);
    const total = sumOf(arith, stageTermsOf(arith, drainTimeout).map(([, term]) => term));
    await expectRefuted(arith, total.eq(drainTimeout.add(61_000)));
  }, SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS);

  it('S2 proves phaseOne(d) = runtimeMaxCloseMs(d) = d + abort budget + teardown budget, and that the margin-free reap grace equals abort + teardown, for every d >= 0', async () => {
    const arith = proofArith(z3.engine().api, 'S2');
    const drainTimeout = drainTimeoutOf(arith);
    const phaseOne = runtimeCloseOf(arith, drainTimeout);
    const reapGraceWithoutMargin = constant(arith, RUNTIME_ABORT_BUDGET_MS).add(constant(arith, RUNTIME_TEARDOWN_BUDGET_MS));
    const { ctx } = arith;
    expect(await prove(arith, ctx.And(phaseOne.eq(drainTimeout.add(15_000)), reapGraceWithoutMargin.eq(15_000)))).toEqual({ status: 'proved' });
    for (const sample of SAMPLED_DRAIN_TIMEOUTS_MS) expect(runtimeMaxCloseMs(sample)).toBe(sample + 15_000);
  }, SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS);

  const clientBoundArith = (name: string) => {
    const arith = proofArith(z3.engine().api, name);
    const drainTimeout = drainTimeoutOf(arith);
    const phaseOne = runtimeCloseOf(arith, drainTimeout);
    const reapGrace = constant(arith, ORPHAN_REAP_GRACE_MS);
    const startup = constant(arith, STARTUP_TIMEOUT_MS);
    const required = phaseOne.add(reapGrace).add(startup);
    return { arith, drainTimeout, phaseOne, reapGrace, startup, required };
  };

  it('S3 proves daemonReadyBoundMs(d) >= phaseOne(d) + ORPHAN_REAP_GRACE_MS + STARTUP_TIMEOUT_MS for every d >= 0 when the bound is that sum', async () => {
    const { arith, required } = clientBoundArith('S3');
    expect(await prove(arith, required.ge(required))).toEqual({ status: 'proved' });
  }, SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS);

  it('S3w refutes the same inequality for today\'s formula ORPHAN_REAP_GRACE_MS + STARTUP_TIMEOUT_MS, with a counter-example for every d >= 0', async () => {
    const { arith, drainTimeout, phaseOne, reapGrace, startup, required } = clientBoundArith('S3w');
    const today = reapGrace.add(startup);
    const model = await expectRefuted(arith, today.ge(required));
    expect(BigInt(model.drainTimeoutMs as string)).toBeGreaterThanOrEqual(0n);
    expect(await prove(arith, today.lt(required))).toEqual({ status: 'proved' });
    expect(await prove(arith, required.sub(today).eq(phaseOne))).toEqual({ status: 'proved' });
    expect(await prove(arith, phaseOne.ge(drainTimeout.add(15_000)))).toEqual({ status: 'proved' });
    expect(ORPHAN_REAP_GRACE_MS + STARTUP_TIMEOUT_MS).toBeLessThan(runtimeMaxCloseMs(0) + ORPHAN_REAP_GRACE_MS + STARTUP_TIMEOUT_MS);
  }, SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS);
});
