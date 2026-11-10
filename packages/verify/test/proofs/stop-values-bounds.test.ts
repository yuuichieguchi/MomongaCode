import { describe, expect, it } from 'vitest';
import { proofArith } from '../../src/proofs/arith.ts';
import type { ProofArith, ProofInt } from '../../src/proofs/arith.ts';
import { expectRefuted, prove } from '../../src/proofs/prove.ts';
import { SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS, useZ3 } from '../harness.ts';

const STARTUP_TIMEOUT_MS = 60_000;

const HELD_CALL_SETTLE_MS = 2_000;
const SANDBOX_KILL_GRACE_MS = 1_000;
const GROUP_POLL_INTERVAL_MS = 10;
const RUNTIME_ABORT_MS = HELD_CALL_SETTLE_MS + SANDBOX_KILL_GRACE_MS + 5_000 + 2 * GROUP_POLL_INTERVAL_MS;
const RUNTIME_TEARDOWN_MS = 10_000;
const SHUTDOWN_MARGIN_MS = 5_000;
const ENTRY_HARD_EXIT_MARGIN_MS = 3_000;
const SHUTDOWN_DRAIN_BOUND_MS = 2_000;
const SHUTDOWN_REAP_BOUND_MS = 4_000;
const SHUTDOWN_RELEASE_BOUND_MS = 5_000;
const KILL_CONFIRM_MS = 5_000;
const CHILD_STDIO_FLUSH_MS = 1_000;
const REAP_POLL_INTERVAL_MS = 25;
const MARKER_PRE_KILL_WINDOWS = 3;
const FM_TERMINATE_WAITS = 1;
const MCP_CONNECTION_GRACE_WAITS = 6;
const CLOSE_GRACE_MAX_MS = 300_000;
const STOP_GRACE_MAX_MS = 60_000;
const DRAIN_MAX_MS = 300_000;
const MCP_CLOSE_GRACE_MAX_MS = 30_000;
const CANCEL_UPSTREAM_SETTLE_MS = 1_000;
const TEARDOWN_OTHER_STEPS_MIN_MS = 9_000;
const SUPERVISOR_FIXED_MS = 76_245;

const constant = (arith: ProofArith, value: number): ProofInt => arith.ctx.Int.val(BigInt(value));

const sumOf = (arith: ProofArith, terms: readonly ProofInt[]): ProofInt => terms.reduce((total, term) => total.add(term), constant(arith, 0));

type Values = { readonly drain: ProofInt; readonly closeGrace: ProofInt; readonly stopGrace: ProofInt; readonly mcpGrace: ProofInt };

const valuesOf = (arith: ProofArith, name: string): Values => {
  const drain = arith.int(`${name}.drain`);
  const closeGrace = arith.int(`${name}.closeGrace`);
  const stopGrace = arith.int(`${name}.stopGrace`);
  const mcpGrace = arith.int(`${name}.mcpGrace`);
  arith.given(
    drain.ge(0), drain.le(DRAIN_MAX_MS),
    closeGrace.ge(0), closeGrace.le(CLOSE_GRACE_MAX_MS),
    stopGrace.ge(0), stopGrace.le(STOP_GRACE_MAX_MS),
    mcpGrace.ge(0), mcpGrace.le(MCP_CLOSE_GRACE_MAX_MS),
  );
  return { drain, closeGrace, stopGrace, mcpGrace };
};

const markerReapOf = (arith: ProofArith, graceMs: ProofInt): ProofInt =>
  constant(arith, MARKER_PRE_KILL_WINDOWS).mul(graceMs.add(constant(arith, REAP_POLL_INTERVAL_MS))).add(constant(arith, KILL_CONFIRM_MS));

const mcpPoolCloseOf = (arith: ProofArith, mcpGrace: ProofInt): ProofInt =>
  mcpGrace
    .add(mcpGrace.add(constant(arith, KILL_CONFIRM_MS)))
    .add(mcpGrace)
    .add(markerReapOf(arith, mcpGrace));

const mcpPoolsStepOf = (arith: ProofArith, mcpGrace: ProofInt): ProofInt => mcpPoolCloseOf(arith, mcpGrace);

const teardownOf = (arith: ProofArith, mcpGrace: ProofInt): ProofInt => constant(arith, RUNTIME_TEARDOWN_MS).add(mcpPoolsStepOf(arith, mcpGrace));

const runtimeMaxOf = (arith: ProofArith, v: Values): ProofInt => v.drain.add(constant(arith, RUNTIME_ABORT_MS)).add(teardownOf(arith, v.mcpGrace));

const runtimeStopOf = (arith: ProofArith, v: Values): ProofInt => runtimeMaxOf(arith, v).add(constant(arith, SHUTDOWN_MARGIN_MS));

const orphanGraceOf = (arith: ProofArith, v: Values): ProofInt => constant(arith, RUNTIME_ABORT_MS).add(teardownOf(arith, v.mcpGrace));

const fmServeStopOf = (arith: ProofArith, stopGrace: ProofInt): ProofInt =>
  stopGrace.mul(constant(arith, FM_TERMINATE_WAITS)).add(constant(arith, KILL_CONFIRM_MS)).add(markerReapOf(arith, stopGrace));

const gatewayStopOf = (arith: ProofArith, v: Values): ProofInt =>
  v.closeGrace.add(fmServeStopOf(arith, v.stopGrace)).add(constant(arith, SHUTDOWN_MARGIN_MS));

const managedReapOf = (arith: ProofArith, v: Values): ProofInt => markerReapOf(arith, v.stopGrace);

const killedChildSettleOf = (arith: ProofArith): ProofInt => constant(arith, KILL_CONFIRM_MS + CHILD_STDIO_FLUSH_MS);

const supervisorCloseOf = (arith: ProofArith, v: Values): ProofInt =>
  sumOf(arith, [
    constant(arith, SHUTDOWN_DRAIN_BOUND_MS),
    runtimeStopOf(arith, v),
    killedChildSettleOf(arith),
    gatewayStopOf(arith, v),
    killedChildSettleOf(arith),
    managedReapOf(arith, v),
    constant(arith, SHUTDOWN_REAP_BOUND_MS),
    constant(arith, SHUTDOWN_RELEASE_BOUND_MS),
  ]);

const daemonStopOf = (arith: ProofArith, v: Values): ProofInt => supervisorCloseOf(arith, v).add(constant(arith, ENTRY_HARD_EXIT_MARGIN_MS));

const DEFAULTS = { drain: 30_000, closeGrace: 10_000, stopGrace: 3_000, mcpGrace: 1_000 } as const;

const pinned = (arith: ProofArith, values: Record<keyof typeof DEFAULTS, number>): Values => ({
  drain: constant(arith, values.drain),
  closeGrace: constant(arith, values.closeGrace),
  stopGrace: constant(arith, values.stopGrace),
  mcpGrace: constant(arith, values.mcpGrace),
});

describe('stop values: the derived bounds of the runtime and of the supervisor (design-close-grace-settings rev 7)', () => {
  const z3 = useZ3();

  it('MS1 proves the teardown budget and the runtime close are the closed forms of the formulas, for every drain and MCP grace in range', async () => {
    const arith = proofArith(z3.engine().api, 'MS1');
    const v = valuesOf(arith, 'v');
    expect(await prove(arith, teardownOf(arith, v.mcpGrace).eq(v.mcpGrace.mul(constant(arith, 6)).add(constant(arith, RUNTIME_TEARDOWN_MS + 10_075))))).toEqual({ status: 'proved' });
    expect(await prove(arith, runtimeMaxOf(arith, v).eq(v.drain.add(v.mcpGrace.mul(constant(arith, 6))).add(constant(arith, 28_095))))).toEqual({ status: 'proved' });
  }, SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS);

  it('MS2 refutes that today\'s fixed 10 000 ms teardown budget contains the mcp-pools step for every MCP grace in range (a counter-model exists; at grace 0 the step is 10 075 ms and at grace 30 000 it is 190 075 ms)', async () => {
    const arith = proofArith(z3.engine().api, 'MS2');
    const v = valuesOf(arith, 'v');
    await expectRefuted(arith, mcpPoolsStepOf(arith, v.mcpGrace).le(constant(arith, RUNTIME_TEARDOWN_MS)));
  }, SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS);

  it('MS2d proves the mcp-pools step bound at the default grace is 16 075 ms, one pool close (the parallel closes share one step)', async () => {
    const arith = proofArith(z3.engine().api, 'MS2d');
    const at = pinned(arith, DEFAULTS);
    expect(await prove(arith, mcpPoolsStepOf(arith, at.mcpGrace).eq(constant(arith, 16_075)))).toEqual({ status: 'proved' });
  }, SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS);

  it('MS3 proves the supervisor close is the closed form at every value in range, and that the daemon stop bound covers the supervisor close and the runtime and gateway stops', async () => {
    const arith = proofArith(z3.engine().api, 'MS3');
    const v = valuesOf(arith, 'v');
    const { ctx } = arith;
    const closed = v.drain
      .add(v.closeGrace)
      .add(v.stopGrace.mul(constant(arith, 7)))
      .add(v.mcpGrace.mul(constant(arith, 6)))
      .add(constant(arith, SUPERVISOR_FIXED_MS));
    expect(await prove(arith, supervisorCloseOf(arith, v).eq(closed))).toEqual({ status: 'proved' });
    expect(await prove(arith, ctx.And(daemonStopOf(arith, v).ge(supervisorCloseOf(arith, v)), supervisorCloseOf(arith, v).ge(runtimeStopOf(arith, v)), supervisorCloseOf(arith, v).ge(gatewayStopOf(arith, v))))).toEqual({ status: 'proved' });
  }, SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS);

  it('MS4 proves every bound is monotone in every value, and the daemon stop bound is finite at the maxima (1 279 245 ms)', async () => {
    const arith = proofArith(z3.engine().api, 'MS4');
    const v = valuesOf(arith, 'v');
    const w = valuesOf(arith, 'w');
    const { ctx } = arith;
    const bigger = { drain: w.drain, closeGrace: w.closeGrace, stopGrace: w.stopGrace, mcpGrace: w.mcpGrace };
    expect(await prove(arith, ctx.Implies(ctx.And(v.drain.le(w.drain), v.closeGrace.le(w.closeGrace), v.stopGrace.le(w.stopGrace), v.mcpGrace.le(w.mcpGrace)), daemonStopOf(arith, v).le(daemonStopOf(arith, bigger))))).toEqual({ status: 'proved' });
    const top = pinned(arith, { drain: DRAIN_MAX_MS, closeGrace: CLOSE_GRACE_MAX_MS, stopGrace: STOP_GRACE_MAX_MS, mcpGrace: MCP_CLOSE_GRACE_MAX_MS });
    expect(await prove(arith, daemonStopOf(arith, top).eq(constant(arith, 1_279_245)))).toEqual({ status: 'proved' });
  }, SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS);

  it('MS5 proves the zero values give the stated numbers: runtime maximum 28 095 and supervisor close 107 245 with the default gateway values', async () => {
    const arith = proofArith(z3.engine().api, 'MS5');
    const zero = pinned(arith, { drain: 0, closeGrace: 0, stopGrace: 0, mcpGrace: 0 });
    expect(await prove(arith, runtimeMaxOf(arith, zero).eq(constant(arith, 28_095)))).toEqual({ status: 'proved' });
    const withDefaults = { ...zero, closeGrace: constant(arith, 10_000), stopGrace: constant(arith, 3_000) };
    expect(await prove(arith, supervisorCloseOf(arith, withDefaults).eq(constant(arith, 107_245)))).toEqual({ status: 'proved' });
  }, SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS);

  it('MS6 proves the teardown order: the derived budget leaves mcp-pools at least its share after cancel-upstream, and the other steps at least 9 000 ms after it, for every MCP grace in range', async () => {
    const arith = proofArith(z3.engine().api, 'MS6');
    const v = valuesOf(arith, 'v');
    const budget = teardownOf(arith, v.mcpGrace);
    const mcpShare = mcpPoolsStepOf(arith, v.mcpGrace);
    const afterCancel = budget.sub(constant(arith, CANCEL_UPSTREAM_SETTLE_MS));
    expect(await prove(arith, afterCancel.ge(mcpShare))).toEqual({ status: 'proved' });
    expect(await prove(arith, afterCancel.sub(mcpShare).ge(constant(arith, TEARDOWN_OTHER_STEPS_MIN_MS)))).toEqual({ status: 'proved' });
  }, SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS);

  const readyRequirementOf = (arith: ProofArith, v: Values): ProofInt => runtimeMaxOf(arith, v).add(orphanGraceOf(arith, v));

  it('MS7 proves the ready requirement at any predecessor values is at most its value at the maxima, so the unknown case covers every known case', async () => {
    const arith = proofArith(z3.engine().api, 'MS7');
    const v = valuesOf(arith, 'v');
    const top = pinned(arith, { drain: DRAIN_MAX_MS, closeGrace: CLOSE_GRACE_MAX_MS, stopGrace: STOP_GRACE_MAX_MS, mcpGrace: MCP_CLOSE_GRACE_MAX_MS });
    expect(await prove(arith, readyRequirementOf(arith, top).ge(readyRequirementOf(arith, v)))).toEqual({ status: 'proved' });
  }, SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS);

  it('MS8 proves the known-values wait covers the predecessor runtime close and its orphan grace for every value in range, and proves today\'s 75 000 ms ready bound is below that requirement for every value in range', async () => {
    const arith = proofArith(z3.engine().api, 'MS8');
    const v = valuesOf(arith, 'v');
    const required = readyRequirementOf(arith, v).add(constant(arith, STARTUP_TIMEOUT_MS));
    expect(await prove(arith, required.ge(runtimeMaxOf(arith, v).add(orphanGraceOf(arith, v)).add(constant(arith, STARTUP_TIMEOUT_MS))))).toEqual({ status: 'proved' });
    expect(await prove(arith, constant(arith, 75_000).lt(required))).toEqual({ status: 'proved' });
  }, SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS);
});
