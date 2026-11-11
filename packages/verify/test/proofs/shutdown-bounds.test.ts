import { describe, expect, it } from 'vitest';
import {
  CHILD_STDIO_FLUSH_MS,
  DEFAULT_STOP_VALUES,
  KILL_CONFIRM_MS,
  ENTRY_HARD_EXIT_MARGIN_MS,
  MAXIMUM_STOP_VALUES,
  RUNTIME_ABORT_BUDGET_MS,
  RUNTIME_TEARDOWN_BUDGET_MS,
  SHUTDOWN_DRAIN_BOUND_MS,
  SHUTDOWN_MARGIN_MS,
  SHUTDOWN_REAP_BOUND_MS,
  SHUTDOWN_RELEASE_BOUND_MS,
  SHUTDOWN_SETTING_LIMITS,
  daemonStopBoundMs,
  managedServerStopBoundMs,
  gatewayAbortBudgetMs,
  gatewayMaxCloseMs,
  gatewayStopBudgetMs,
  REAP_POLL_INTERVAL_MS,
  STARTUP_TIMEOUT_MS,
  managedServerReapBoundMs,
  markerReapClockBoundMs,
  mcpPoolCloseBoundMs,
  orphanReapGraceMs,
  runtimeMaxCloseMs,
  runtimeStopBudgetMs,
  runtimeTeardownBudgetMs,
  supervisorMaxCloseMs,
} from '@momonga/foundation';
import type { StopValues as ProductStopValues } from '@momonga/foundation';
import { resolveStartTiming, supervisorStartBoundMs } from '@momonga/supervisor';
import { proofArith } from '../support/proofs/arith.ts';
import type { ProofArith, ProofInt } from '../support/proofs/arith.ts';
import { expectRefuted, prove } from '../support/proofs/prove.ts';
import { SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS, useZ3 } from '../harness.ts';

const constant = (arith: ProofArith, value: number): ProofInt => arith.ctx.Int.val(BigInt(value));

const sumOf = (arith: ProofArith, terms: readonly ProofInt[]): ProofInt => terms.reduce((total, term) => total.add(term), constant(arith, 0));

const MANAGED_STOP_GRACE_WINDOWS = 4;
const MANAGED_REAP_GRACE_WINDOWS = 3;
const MCP_CLOSE_GRACE_WINDOWS = 6;
const MANAGED_STOP_FIXED_MS = MANAGED_REAP_GRACE_WINDOWS * REAP_POLL_INTERVAL_MS + 2 * KILL_CONFIRM_MS;
const MANAGED_REAP_FIXED_MS = MANAGED_REAP_GRACE_WINDOWS * REAP_POLL_INTERVAL_MS + KILL_CONFIRM_MS;
const MCP_CLOSE_FIXED_MS = MANAGED_REAP_GRACE_WINDOWS * REAP_POLL_INTERVAL_MS + 2 * KILL_CONFIRM_MS;
const RUNTIME_CLOSE_FIXED_MS = RUNTIME_ABORT_BUDGET_MS + RUNTIME_TEARDOWN_BUDGET_MS + MCP_CLOSE_FIXED_MS;
const SUPERVISOR_FIXED_CLOSE_MS =
  SHUTDOWN_DRAIN_BOUND_MS +
  RUNTIME_CLOSE_FIXED_MS +
  SHUTDOWN_MARGIN_MS +
  2 * (KILL_CONFIRM_MS + CHILD_STDIO_FLUSH_MS) +
  MANAGED_STOP_FIXED_MS +
  SHUTDOWN_MARGIN_MS +
  MANAGED_REAP_FIXED_MS +
  SHUTDOWN_REAP_BOUND_MS +
  SHUTDOWN_RELEASE_BOUND_MS;

type StopValues = { readonly closeGraceMs: ProofInt; readonly managedServerStopGraceMs: ProofInt; readonly drainTimeoutMs: ProofInt; readonly mcpCloseGraceMs: ProofInt };

const stopValuesOf = (arith: ProofArith, name: string): StopValues => {
  const within = (key: keyof ProductStopValues): ProofInt => {
    const value = arith.int(`${name}.${key}`);
    arith.given(value.ge(SHUTDOWN_SETTING_LIMITS[key].min), value.le(SHUTDOWN_SETTING_LIMITS[key].max));
    return value;
  };
  return { closeGraceMs: within('closeGraceMs'), managedServerStopGraceMs: within('managedServerStopGraceMs'), drainTimeoutMs: within('drainTimeoutMs'), mcpCloseGraceMs: within('mcpCloseGraceMs') };
};

const constantValues = (arith: ProofArith, values: ProductStopValues): StopValues => ({
  closeGraceMs: constant(arith, values.closeGraceMs),
  managedServerStopGraceMs: constant(arith, values.managedServerStopGraceMs),
  drainTimeoutMs: constant(arith, values.drainTimeoutMs),
  mcpCloseGraceMs: constant(arith, values.mcpCloseGraceMs),
});

const managedStopOf = (arith: ProofArith, values: StopValues): ProofInt => constant(arith, MANAGED_STOP_GRACE_WINDOWS).mul(values.managedServerStopGraceMs).add(constant(arith, MANAGED_STOP_FIXED_MS));

const managedReapOf = (arith: ProofArith, values: StopValues): ProofInt => constant(arith, MANAGED_REAP_GRACE_WINDOWS).mul(values.managedServerStopGraceMs).add(constant(arith, MANAGED_REAP_FIXED_MS));

const runtimeCloseOf = (arith: ProofArith, values: StopValues): ProofInt =>
  values.drainTimeoutMs.add(constant(arith, MCP_CLOSE_GRACE_WINDOWS).mul(values.mcpCloseGraceMs)).add(constant(arith, RUNTIME_CLOSE_FIXED_MS));

const orphanReapGraceOf = (arith: ProofArith, values: StopValues): ProofInt => constant(arith, MCP_CLOSE_GRACE_WINDOWS).mul(values.mcpCloseGraceMs).add(constant(arith, RUNTIME_CLOSE_FIXED_MS));

const gatewayCloseOf = (arith: ProofArith, values: StopValues): ProofInt => values.closeGraceMs.add(managedStopOf(arith, values));

const gatewayStopOf = (arith: ProofArith, values: StopValues): ProofInt => gatewayCloseOf(arith, values).add(constant(arith, SHUTDOWN_MARGIN_MS));

const gatewayAbortStopOf = (arith: ProofArith, values: StopValues): ProofInt => managedStopOf(arith, values).add(constant(arith, SHUTDOWN_MARGIN_MS));

const supervisorCloseOf = (arith: ProofArith, values: StopValues): ProofInt => {
  const killedChildSettle = constant(arith, KILL_CONFIRM_MS).add(constant(arith, CHILD_STDIO_FLUSH_MS));
  return sumOf(arith, [
    constant(arith, SHUTDOWN_DRAIN_BOUND_MS),
    runtimeCloseOf(arith, values).add(constant(arith, SHUTDOWN_MARGIN_MS)),
    killedChildSettle,
    gatewayStopOf(arith, values),
    killedChildSettle,
    managedReapOf(arith, values),
    constant(arith, SHUTDOWN_REAP_BOUND_MS),
    constant(arith, SHUTDOWN_RELEASE_BOUND_MS),
  ]);
};

const daemonStopOf = (arith: ProofArith, values: StopValues): ProofInt => supervisorCloseOf(arith, values).add(constant(arith, ENTRY_HARD_EXIT_MARGIN_MS));

const SAMPLED_VALUES: readonly ProductStopValues[] = [
  DEFAULT_STOP_VALUES,
  MAXIMUM_STOP_VALUES,
  { closeGraceMs: 0, managedServerStopGraceMs: 0, drainTimeoutMs: 0, mcpCloseGraceMs: 0 },
  { closeGraceMs: 1234, managedServerStopGraceMs: 567, drainTimeoutMs: 7, mcpCloseGraceMs: 40 },
];

describe('shutdown and start-up bounds (design-probe-timeout Z3 item 3; the closed forms are proved in stop-values-bounds.test.ts, MS1 to MS8)', () => {
  const z3 = useZ3();

  it('reads the closed forms of the code at sampled stop values, so the proofs below describe the code and not themselves', () => {
    expect(REAP_POLL_INTERVAL_MS).toBe(25);
    expect(KILL_CONFIRM_MS).toBe(5000);
    expect(RUNTIME_ABORT_BUDGET_MS).toBe(8020);
    expect(SUPERVISOR_FIXED_CLOSE_MS).toBe(76_245);
    for (const values of SAMPLED_VALUES) {
      const { closeGraceMs: c, managedServerStopGraceMs: m, drainTimeoutMs: d, mcpCloseGraceMs: g } = values;
      expect(managedServerStopBoundMs(m)).toBe(MANAGED_STOP_GRACE_WINDOWS * m + MANAGED_STOP_FIXED_MS);
      expect(managedServerReapBoundMs(values)).toBe(markerReapClockBoundMs(m));
      expect(managedServerReapBoundMs(values)).toBe(MANAGED_REAP_GRACE_WINDOWS * m + MANAGED_REAP_FIXED_MS);
      expect(mcpPoolCloseBoundMs(g)).toBe(MCP_CLOSE_GRACE_WINDOWS * g + MCP_CLOSE_FIXED_MS);
      expect(runtimeTeardownBudgetMs(g)).toBe(RUNTIME_TEARDOWN_BUDGET_MS + MCP_CLOSE_GRACE_WINDOWS * g + MCP_CLOSE_FIXED_MS);
      expect(runtimeMaxCloseMs(values)).toBe(d + MCP_CLOSE_GRACE_WINDOWS * g + RUNTIME_CLOSE_FIXED_MS);
      expect(runtimeStopBudgetMs(values)).toBe(runtimeMaxCloseMs(values) + SHUTDOWN_MARGIN_MS);
      expect(orphanReapGraceMs(values)).toBe(MCP_CLOSE_GRACE_WINDOWS * g + RUNTIME_CLOSE_FIXED_MS);
      expect(gatewayMaxCloseMs(values)).toBe(c + managedServerStopBoundMs(m));
      expect(gatewayStopBudgetMs(values)).toBe(c + MANAGED_STOP_GRACE_WINDOWS * m + MANAGED_STOP_FIXED_MS + SHUTDOWN_MARGIN_MS);
      expect(gatewayAbortBudgetMs(values)).toBe(MANAGED_STOP_GRACE_WINDOWS * m + MANAGED_STOP_FIXED_MS + SHUTDOWN_MARGIN_MS);
      expect(supervisorMaxCloseMs(values)).toBe(d + c + (MANAGED_STOP_GRACE_WINDOWS + MANAGED_REAP_GRACE_WINDOWS) * m + MCP_CLOSE_GRACE_WINDOWS * g + SUPERVISOR_FIXED_CLOSE_MS);
      expect(daemonStopBoundMs(values)).toBe(supervisorMaxCloseMs(values) + ENTRY_HARD_EXIT_MARGIN_MS);
    }
    expect(daemonStopBoundMs(MAXIMUM_STOP_VALUES)).toBe(1_279_245);
    expect(SHUTDOWN_SETTING_LIMITS.managedServerStopGraceMs.max).toBe(STARTUP_TIMEOUT_MS);
    expect(SHUTDOWN_MARGIN_MS + ENTRY_HARD_EXIT_MARGIN_MS).toBe(8000);
  });

  const clientBoundArith = (name: string) => {
    const arith = proofArith(z3.engine().api, name);
    const predecessor = stopValuesOf(arith, 'predecessor');
    const phaseOne = runtimeCloseOf(arith, predecessor);
    const reapGrace = orphanReapGraceOf(arith, predecessor);
    const startup = constant(arith, STARTUP_TIMEOUT_MS);
    const readyBound = constant(arith, supervisorStartBoundMs(resolveStartTiming({})));
    const withPredecessorWait = phaseOne.add(reapGrace).add(startup);
    return { arith, predecessor, phaseOne, startup, readyBound, withPredecessorWait };
  };

  it('S3 proves the ready bound of a start is STARTUP_TIMEOUT_MS for every stop value of a previous daemon: a start waits for no previous daemon', async () => {
    const { arith, startup, readyBound } = clientBoundArith('S3');
    expect(await prove(arith, readyBound.eq(startup))).toEqual({ status: 'proved' });
    expect(supervisorStartBoundMs(resolveStartTiming({ predecessorStopValues: MAXIMUM_STOP_VALUES }))).toBe(STARTUP_TIMEOUT_MS);
  }, SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS);

  it('S3w refutes that bound for a start that waited for a previous daemon to close, with a counter-example for every allowed stop value', async () => {
    const { arith, predecessor, phaseOne, readyBound, withPredecessorWait } = clientBoundArith('S3w');
    const model = await expectRefuted(arith, readyBound.ge(withPredecessorWait));
    expect(BigInt(model['predecessor.drainTimeoutMs'] as string)).toBeGreaterThanOrEqual(0n);
    expect(await prove(arith, readyBound.lt(withPredecessorWait))).toEqual({ status: 'proved' });
    expect(await prove(arith, phaseOne.ge(predecessor.drainTimeoutMs.add(RUNTIME_CLOSE_FIXED_MS)))).toEqual({ status: 'proved' });
  }, SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS);
});

describe('read-at-stop: the values a stop carries bound every wait of that stop (design-close-grace-settings rev 8, section 3)', () => {
  const z3 = useZ3();

  it('RS6 refutes M1: a supervisor that bounds its close with the new file value, while its gateway child stops with the value it read at its own begin, cannot cover that child\'s stop', async () => {
    const arith = proofArith(z3.engine().api, 'RS6');
    const oldValues = stopValuesOf(arith, 'old');
    const newValues = stopValuesOf(arith, 'new');
    const model = await expectRefuted(arith, supervisorCloseOf(arith, newValues).ge(gatewayStopOf(arith, oldValues)));
    expect(model).toBeDefined();
  }, SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS);

  it('RS7 refutes M2: a waiter that reads the file after a stop began, and so bounds the stop with a later value, cannot cover the stop bound the stop carries', async () => {
    const arith = proofArith(z3.engine().api, 'RS7');
    const oldValues = stopValuesOf(arith, 'old');
    const laterValues = stopValuesOf(arith, 'later');
    const { ctx } = arith;
    const same = ctx.And(
      oldValues.closeGraceMs.eq(laterValues.closeGraceMs),
      oldValues.managedServerStopGraceMs.eq(laterValues.managedServerStopGraceMs),
      oldValues.drainTimeoutMs.eq(laterValues.drainTimeoutMs),
      oldValues.mcpCloseGraceMs.eq(laterValues.mcpCloseGraceMs),
    );
    expect(await expectRefuted(arith, daemonStopOf(arith, laterValues).ge(daemonStopOf(arith, oldValues)))).toBeDefined();
    expect(await prove(arith, ctx.Implies(same, daemonStopOf(arith, laterValues).eq(daemonStopOf(arith, oldValues))))).toEqual({ status: 'proved' });
  }, SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS);

  it('RS8 refutes M3: a gateway close that ignores its stop\'s managed-server value (uses the default 3 000 ms) does not cover its close grace plus its managed-server stop bound', async () => {
    const arith = proofArith(z3.engine().api, 'RS8');
    const values = stopValuesOf(arith, 'stop');
    const fixedManaged = constant(arith, managedServerStopBoundMs(DEFAULT_STOP_VALUES.managedServerStopGraceMs));
    expect(await expectRefuted(arith, values.closeGraceMs.add(fixedManaged).ge(gatewayCloseOf(arith, values)))).toBeDefined();
  }, SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS);

  it('RS9 refutes M4: a daemon stop bound that drops the gateway close grace does not cover the daemon close', async () => {
    const arith = proofArith(z3.engine().api, 'RS9');
    const values = stopValuesOf(arith, 'stop');
    const withoutGateway = daemonStopOf(arith, { ...values, closeGraceMs: constant(arith, 0) });
    expect(await expectRefuted(arith, withoutGateway.ge(daemonStopOf(arith, values)))).toBeDefined();
  }, SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS);

  it('RS10 proves the abort budget of a gateway never exceeds its term budget, so a switch to abort never lengthens the supervisor close, and that the supervisor close covers the managed-server reap of its stop', async () => {
    const arith = proofArith(z3.engine().api, 'RS10');
    const values = stopValuesOf(arith, 'stop');
    const { ctx } = arith;
    expect(await prove(arith, ctx.And(
      gatewayAbortStopOf(arith, values).le(gatewayStopOf(arith, values)),
      supervisorCloseOf(arith, values).ge(gatewayStopOf(arith, values).add(managedReapOf(arith, values))),
    ))).toEqual({ status: 'proved' });
  }, SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS);

  it('RS11 proves the pins of section 2.5 at the defaults: runtime close 64 095, supervisor close 143 245, daemon stop 146 245', async () => {
    const arith = proofArith(z3.engine().api, 'RS11');
    const defaults = constantValues(arith, DEFAULT_STOP_VALUES);
    const { ctx } = arith;
    expect(await prove(arith, ctx.And(
      runtimeCloseOf(arith, defaults).eq(constant(arith, 64_095)),
      supervisorCloseOf(arith, defaults).eq(constant(arith, 143_245)),
      daemonStopOf(arith, defaults).eq(constant(arith, 146_245)),
    ))).toEqual({ status: 'proved' });
  }, SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS);
});
