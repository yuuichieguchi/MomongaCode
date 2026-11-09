import { describe, expect, it } from 'vitest';
import {
  CHILD_STDIO_FLUSH_MS,
  DEFAULT_STOP_VALUES,
  KILL_CONFIRM_MS,
  ENTRY_HARD_EXIT_MARGIN_MS,
  RUNTIME_ABORT_BUDGET_MS,
  RUNTIME_DEFAULT_DRAIN_TIMEOUT_MS,
  RUNTIME_TEARDOWN_BUDGET_MS,
  SHUTDOWN_DRAIN_BOUND_MS,
  SHUTDOWN_MARGIN_MS,
  SHUTDOWN_REAP_BOUND_MS,
  SHUTDOWN_RELEASE_BOUND_MS,
  daemonStopBoundMs,
  fmServeStopBoundMs,
  gatewayAbortBudgetMs,
  gatewayMaxCloseMs,
  gatewayStopBudgetMs,
  managedServerReapBoundMs,
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
    ['gatewayStop', constant(arith, DEFAULT_STOP_VALUES.closeGraceMs).add(constant(arith, fmServeStopBoundMs(DEFAULT_STOP_VALUES.managedServerStopGraceMs))).add(constant(arith, SHUTDOWN_MARGIN_MS))],
    ['gatewayKilledChildSettle', killedChildSettle],
    ['managedServerReap', constant(arith, managedServerReapBoundMs(DEFAULT_STOP_VALUES))],
    ['reap', constant(arith, SHUTDOWN_REAP_BOUND_MS)],
    ['release', constant(arith, SHUTDOWN_RELEASE_BOUND_MS)],
  ];
};

const sumOf = (arith: ProofArith, terms: readonly ProofInt[]): ProofInt => terms.reduce((total, term) => total.add(term), constant(arith, 0));

const SAMPLED_DRAIN_TIMEOUTS_MS = [0, 1, 30_000, 123_456] as const;

const SUPERVISOR_FIXED_CLOSE_MS =
  SHUTDOWN_DRAIN_BOUND_MS +
  RUNTIME_ABORT_BUDGET_MS +
  RUNTIME_TEARDOWN_BUDGET_MS +
  SHUTDOWN_MARGIN_MS +
  2 * (KILL_CONFIRM_MS + CHILD_STDIO_FLUSH_MS) +
  DEFAULT_STOP_VALUES.closeGraceMs +
  fmServeStopBoundMs(DEFAULT_STOP_VALUES.managedServerStopGraceMs) +
  SHUTDOWN_MARGIN_MS +
  managedServerReapBoundMs(DEFAULT_STOP_VALUES) +
  SHUTDOWN_REAP_BOUND_MS +
  SHUTDOWN_RELEASE_BOUND_MS;

describe('shutdown and start-up bounds (design-probe-timeout Z3 item 3)', () => {
  const z3 = useZ3();

  it('reads the closed forms of the code at sampled drain timeouts, so the proofs below describe the code and not themselves', () => {
    const fixedTerms = SHUTDOWN_DRAIN_BOUND_MS + SHUTDOWN_MARGIN_MS + 2 * (KILL_CONFIRM_MS + CHILD_STDIO_FLUSH_MS) + gatewayMaxCloseMs(DEFAULT_STOP_VALUES) + SHUTDOWN_MARGIN_MS + managedServerReapBoundMs(DEFAULT_STOP_VALUES) + SHUTDOWN_REAP_BOUND_MS + SHUTDOWN_RELEASE_BOUND_MS;
    for (const drainTimeout of SAMPLED_DRAIN_TIMEOUTS_MS) {
      expect(runtimeMaxCloseMs(drainTimeout)).toBe(drainTimeout + RUNTIME_ABORT_BUDGET_MS + RUNTIME_TEARDOWN_BUDGET_MS);
      expect(supervisorMaxCloseMs(drainTimeout, DEFAULT_STOP_VALUES)).toBe(drainTimeout + RUNTIME_ABORT_BUDGET_MS + RUNTIME_TEARDOWN_BUDGET_MS + fixedTerms);
    }
    expect(gatewayMaxCloseMs(DEFAULT_STOP_VALUES)).toBe(DEFAULT_STOP_VALUES.closeGraceMs + fmServeStopBoundMs(DEFAULT_STOP_VALUES.managedServerStopGraceMs));
    expect(supervisorMaxCloseMs(0, DEFAULT_STOP_VALUES)).toBe(SUPERVISOR_FIXED_CLOSE_MS);
    expect(SUPERVISOR_FIXED_CLOSE_MS).toBe(88_000);
  });

  it('S1 proves supervisorMaxCloseMs(d, defaults) is the sum of its eight stage terms, each non-negative, and equals d + the fixed close terms, the gateway close grace, the managed-server stop bound and the managed-server reap included, for every d >= 0', async () => {
    const arith = proofArith(z3.engine().api, 'S1');
    const drainTimeout = drainTimeoutOf(arith);
    const terms = stageTermsOf(arith, drainTimeout);
    expect(terms.map(([name]) => name)).toEqual(['drain', 'runtimeStop', 'runtimeKilledChildSettle', 'gatewayStop', 'gatewayKilledChildSettle', 'managedServerReap', 'reap', 'release']);
    const total = sumOf(arith, terms.map(([, term]) => term));
    const { ctx } = arith;
    expect(await prove(arith, ctx.And(...terms.map(([, term]) => term.ge(0))))).toEqual({ status: 'proved' });
    expect(await prove(arith, total.eq(drainTimeout.add(SUPERVISOR_FIXED_CLOSE_MS)))).toEqual({ status: 'proved' });
    for (const sample of SAMPLED_DRAIN_TIMEOUTS_MS) expect(supervisorMaxCloseMs(sample, DEFAULT_STOP_VALUES)).toBe(sample + SUPERVISOR_FIXED_CLOSE_MS);
  }, SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS);

  it('S1w refutes a total one managed-server stop grace short, so the closed form of S1 is not satisfied by a wrong constant', async () => {
    const arith = proofArith(z3.engine().api, 'S1w');
    const drainTimeout = drainTimeoutOf(arith);
    const total = sumOf(arith, stageTermsOf(arith, drainTimeout).map(([, term]) => term));
    await expectRefuted(arith, total.eq(drainTimeout.add(SUPERVISOR_FIXED_CLOSE_MS - DEFAULT_STOP_VALUES.managedServerStopGraceMs)));
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

const CLOSE_GRACE_MAX_MS = 300_000;
const STOP_GRACE_MAX_MS = 60_000;
const MANAGED_WAITS_PER_STOP = 6;
const MANAGED_REAP_WINDOWS = 4;
const SUPERVISOR_STAGES_FIXED_MS = SHUTDOWN_DRAIN_BOUND_MS + RUNTIME_ABORT_BUDGET_MS + RUNTIME_TEARDOWN_BUDGET_MS + SHUTDOWN_MARGIN_MS + 2 * (KILL_CONFIRM_MS + CHILD_STDIO_FLUSH_MS) + SHUTDOWN_MARGIN_MS + SHUTDOWN_REAP_BOUND_MS + SHUTDOWN_RELEASE_BOUND_MS;

type StopValues = { readonly closeGraceMs: ProofInt; readonly managedServerStopGraceMs: ProofInt };

const stopValuesOf = (arith: ProofArith, name: string): StopValues => {
  const closeGraceMs = arith.int(`${name}.closeGraceMs`);
  const managedServerStopGraceMs = arith.int(`${name}.managedServerStopGraceMs`);
  arith.given(closeGraceMs.ge(0), closeGraceMs.le(CLOSE_GRACE_MAX_MS), managedServerStopGraceMs.ge(0), managedServerStopGraceMs.le(STOP_GRACE_MAX_MS));
  return { closeGraceMs, managedServerStopGraceMs };
};

const gatewayCloseOf = (arith: ProofArith, values: StopValues): ProofInt => values.closeGraceMs.add(constant(arith, MANAGED_WAITS_PER_STOP).mul(values.managedServerStopGraceMs));

const gatewayStopOf = (arith: ProofArith, values: StopValues): ProofInt => gatewayCloseOf(arith, values).add(constant(arith, SHUTDOWN_MARGIN_MS));

const supervisorCloseOf = (arith: ProofArith, drainTimeout: ProofInt, values: StopValues): ProofInt => {
  const killedChildSettle = constant(arith, KILL_CONFIRM_MS).add(constant(arith, CHILD_STDIO_FLUSH_MS));
  return sumOf(arith, [
    constant(arith, SHUTDOWN_DRAIN_BOUND_MS),
    runtimeCloseOf(arith, drainTimeout).add(constant(arith, SHUTDOWN_MARGIN_MS)),
    killedChildSettle,
    gatewayStopOf(arith, values),
    killedChildSettle,
    constant(arith, MANAGED_REAP_WINDOWS).mul(values.managedServerStopGraceMs),
    constant(arith, SHUTDOWN_REAP_BOUND_MS),
    constant(arith, SHUTDOWN_RELEASE_BOUND_MS),
  ]);
};

const gatewayAbortStopOf = (arith: ProofArith, values: StopValues): ProofInt => constant(arith, MANAGED_WAITS_PER_STOP).mul(values.managedServerStopGraceMs).add(constant(arith, SHUTDOWN_MARGIN_MS));

const daemonStopOf = (arith: ProofArith, values: StopValues): ProofInt =>
  supervisorCloseOf(arith, constant(arith, RUNTIME_DEFAULT_DRAIN_TIMEOUT_MS), values).add(constant(arith, ENTRY_HARD_EXIT_MARGIN_MS));

const maximalValues = (arith: ProofArith): StopValues => ({
  closeGraceMs: constant(arith, CLOSE_GRACE_MAX_MS),
  managedServerStopGraceMs: constant(arith, STOP_GRACE_MAX_MS),
});

describe('read-at-stop: the values a stop carries bound every wait of that stop (design-close-grace-settings rev 5)', () => {
  const z3 = useZ3();

  it('reads the closed forms the arithmetic below uses, from the code, at sampled values', () => {
    expect(fmServeStopBoundMs(1000)).toBe(MANAGED_WAITS_PER_STOP * 1000);
    expect(managedServerReapBoundMs({ closeGraceMs: 0, managedServerStopGraceMs: 1000 })).toBe(MANAGED_REAP_WINDOWS * 1000);
    const sample = { closeGraceMs: 1234, managedServerStopGraceMs: 567 };
    expect(gatewayStopBudgetMs(sample)).toBe(1234 + MANAGED_WAITS_PER_STOP * 567 + SHUTDOWN_MARGIN_MS);
    expect(gatewayAbortBudgetMs(sample)).toBe(MANAGED_WAITS_PER_STOP * 567 + SHUTDOWN_MARGIN_MS);
    expect(supervisorMaxCloseMs(7, sample)).toBe(7 + 1234 + (MANAGED_WAITS_PER_STOP + MANAGED_REAP_WINDOWS) * 567 + SUPERVISOR_STAGES_FIXED_MS);
    expect(daemonStopBoundMs(sample)).toBe(RUNTIME_DEFAULT_DRAIN_TIMEOUT_MS + 1234 + 10 * 567 + SUPERVISOR_STAGES_FIXED_MS + ENTRY_HARD_EXIT_MARGIN_MS);
    expect(daemonStopBoundMs({ closeGraceMs: CLOSE_GRACE_MAX_MS, managedServerStopGraceMs: STOP_GRACE_MAX_MS })).toBe(981_000);
    expect(SUPERVISOR_STAGES_FIXED_MS).toBe(48_000);
    expect(fmServeStopBoundMs(0)).toBe(0);
    expect(STOP_GRACE_MAX_MS).toBe(STARTUP_TIMEOUT_MS);
    expect(SHUTDOWN_MARGIN_MS + ENTRY_HARD_EXIT_MARGIN_MS).toBe(8000);
  });

  it('RS1 proves that for every allowed pair of values and every drain d >= 0, a stop\'s gateway close covers its close grace and its managed-server stop bound, its supervisor close covers its gateway stop budget, and its daemon stop bound covers its supervisor close', async () => {
    const arith = proofArith(z3.engine().api, 'RS1');
    const values = stopValuesOf(arith, 'stop');
    const drainTimeout = drainTimeoutOf(arith);
    const { ctx } = arith;
    const gatewayClose = gatewayCloseOf(arith, values);
    const supervisorClose = supervisorCloseOf(arith, drainTimeout, values);
    expect(await prove(arith, gatewayClose.ge(values.closeGraceMs.add(constant(arith, MANAGED_WAITS_PER_STOP).mul(values.managedServerStopGraceMs))))).toEqual({ status: 'proved' });
    expect(await prove(arith, supervisorClose.ge(gatewayStopOf(arith, values)))).toEqual({ status: 'proved' });
    expect(await prove(arith, ctx.Implies(drainTimeout.eq(constant(arith, RUNTIME_DEFAULT_DRAIN_TIMEOUT_MS)), daemonStopOf(arith, values).ge(supervisorCloseOf(arith, drainTimeout, values))))).toEqual({ status: 'proved' });
  }, SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS);

  it('RS2 proves the supervisor close of one stop is d + closeGrace + 10 managedServerStop + the fixed stages, for every allowed pair of values and every d >= 0', async () => {
    const arith = proofArith(z3.engine().api, 'RS2');
    const values = stopValuesOf(arith, 'stop');
    const drainTimeout = drainTimeoutOf(arith);
    const closed = drainTimeout.add(values.closeGraceMs).add(constant(arith, MANAGED_WAITS_PER_STOP + MANAGED_REAP_WINDOWS).mul(values.managedServerStopGraceMs)).add(constant(arith, SUPERVISOR_STAGES_FIXED_MS));
    expect(await prove(arith, supervisorCloseOf(arith, drainTimeout, values).eq(closed))).toEqual({ status: 'proved' });
  }, SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS);

  it('RS3 proves every bound is monotone in its values and the drain, so a longer grace never shortens a bound', async () => {
    const arith = proofArith(z3.engine().api, 'RS3');
    const first = stopValuesOf(arith, 'first');
    const second = stopValuesOf(arith, 'second');
    const drainFirst = drainTimeoutOf(arith);
    const drainSecond = arith.int('drainSecond');
    arith.given(drainSecond.ge(drainFirst));
    const { ctx } = arith;
    const ordered = ctx.And(first.closeGraceMs.le(second.closeGraceMs), first.managedServerStopGraceMs.le(second.managedServerStopGraceMs));
    expect(await prove(arith, ctx.Implies(ordered, daemonStopOf(arith, first).le(daemonStopOf(arith, second))))).toEqual({ status: 'proved' });
    expect(await prove(arith, ctx.Implies(ctx.And(ordered, drainFirst.le(drainSecond)), supervisorCloseOf(arith, drainFirst, first).le(supervisorCloseOf(arith, drainSecond, second))))).toEqual({ status: 'proved' });
  }, SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS);

  it('RS4 proves every bound is finite: a stop\'s daemon bound is at most its value at the largest allowed values, and a supervisor close is at most its value at the largest values for any drain up to a cap', async () => {
    const arith = proofArith(z3.engine().api, 'RS4');
    const values = stopValuesOf(arith, 'stop');
    const drainTimeout = drainTimeoutOf(arith);
    const cap = constant(arith, 1_000_000_000);
    arith.given(drainTimeout.le(cap));
    const { ctx } = arith;
    expect(await prove(arith, ctx.And(
      daemonStopOf(arith, values).le(daemonStopOf(arith, maximalValues(arith))),
      supervisorCloseOf(arith, drainTimeout, values).le(supervisorCloseOf(arith, cap, maximalValues(arith))),
    ))).toEqual({ status: 'proved' });
  }, SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS);

  it('RS5 proves zero values give the fixed part only: the daemon stop bound is 81 000 ms and the supervisor close at drain 0 is 48 000 ms', async () => {
    const arith = proofArith(z3.engine().api, 'RS5');
    const zero: StopValues = { closeGraceMs: constant(arith, 0), managedServerStopGraceMs: constant(arith, 0) };
    const { ctx } = arith;
    expect(await prove(arith, ctx.And(daemonStopOf(arith, zero).eq(constant(arith, 81_000)), supervisorCloseOf(arith, constant(arith, 0), zero).eq(constant(arith, 48_000))))).toEqual({ status: 'proved' });
  }, SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS);

  it('RS6 refutes M1: a supervisor that bounds its close with the new file value, while its gateway child stops with the value it read at its own begin, cannot cover that child\'s stop', async () => {
    const arith = proofArith(z3.engine().api, 'RS6');
    const oldValues = stopValuesOf(arith, 'old');
    const newValues = stopValuesOf(arith, 'new');
    const drainTimeout = drainTimeoutOf(arith);
    const model = await expectRefuted(arith, supervisorCloseOf(arith, drainTimeout, newValues).ge(gatewayStopOf(arith, oldValues)));
    expect(model).toBeDefined();
  }, SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS);

  it('RS7 refutes M2: a waiter that reads the file after a stop began, and so bounds the stop with a later value, cannot cover the stop bound the stop carries', async () => {
    const arith = proofArith(z3.engine().api, 'RS7');
    const oldValues = stopValuesOf(arith, 'old');
    const laterValues = stopValuesOf(arith, 'later');
    const { ctx } = arith;
    expect(await expectRefuted(arith, daemonStopOf(arith, laterValues).ge(daemonStopOf(arith, oldValues)))).toBeDefined();
    expect(await prove(arith, ctx.Implies(ctx.And(oldValues.closeGraceMs.eq(laterValues.closeGraceMs), oldValues.managedServerStopGraceMs.eq(laterValues.managedServerStopGraceMs)), daemonStopOf(arith, laterValues).eq(daemonStopOf(arith, oldValues))))).toEqual({ status: 'proved' });
  }, SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS);

  it('RS8 refutes M3: a gateway close that ignores its stop\'s managed-server value (uses the default 3 000 ms) does not cover its close grace plus its managed-server stop bound', async () => {
    const arith = proofArith(z3.engine().api, 'RS8');
    const values = stopValuesOf(arith, 'stop');
    const fixedManaged = constant(arith, MANAGED_WAITS_PER_STOP).mul(constant(arith, 3000));
    expect(await expectRefuted(arith, values.closeGraceMs.add(fixedManaged).ge(values.closeGraceMs.add(constant(arith, MANAGED_WAITS_PER_STOP).mul(values.managedServerStopGraceMs))))).toBeDefined();
  }, SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS);

  it('RS9 refutes M4: a daemon stop bound that drops the gateway close does not cover the daemon close', async () => {
    const arith = proofArith(z3.engine().api, 'RS9');
    const values = stopValuesOf(arith, 'stop');
    const withoutGateway = supervisorCloseOf(arith, constant(arith, RUNTIME_DEFAULT_DRAIN_TIMEOUT_MS), { closeGraceMs: constant(arith, 0), managedServerStopGraceMs: constant(arith, 0) }).add(constant(arith, ENTRY_HARD_EXIT_MARGIN_MS));
    expect(await expectRefuted(arith, withoutGateway.ge(daemonStopOf(arith, values)))).toBeDefined();
  }, SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS);

  it('RS10 proves the abort budget of a gateway never exceeds its term budget, so a switch to abort never lengthens the supervisor close, and that the supervisor close covers the managed-server reap of its stop', async () => {
    const arith = proofArith(z3.engine().api, 'RS10');
    const values = stopValuesOf(arith, 'stop');
    const drainTimeout = drainTimeoutOf(arith);
    const { ctx } = arith;
    expect(await prove(arith, ctx.And(
      gatewayAbortStopOf(arith, values).le(gatewayStopOf(arith, values)),
      supervisorCloseOf(arith, drainTimeout, values).ge(gatewayStopOf(arith, values).add(constant(arith, MANAGED_REAP_WINDOWS).mul(values.managedServerStopGraceMs))),
    ))).toEqual({ status: 'proved' });
  }, SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS);
});
