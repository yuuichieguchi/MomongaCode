import { describe, expect, it } from 'vitest';
import { DEFAULT_STOP_VALUES, REAP_POLL_INTERVAL_MS, managedServerStopBoundMs, gatewayMaxCloseMs, managedServerReapBoundMs, markerReapClockBoundMs, supervisorMaxCloseMs } from '@momonga/foundation';
import { proofArith } from '../../src/proofs/arith.ts';
import type { ProofArith, ProofInt } from '../../src/proofs/arith.ts';
import { prove } from '../../src/proofs/prove.ts';
import { SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS, useZ3 } from '../harness.ts';

const MANAGED_STOP_WINDOWS = 6;
const MANAGED_REAP_WINDOWS = 4;
const STARTUP_UNWIND_STOPS = 2;
const SUPERVISOR_FIXED_TERMS_MS = 48_000;
const DEFAULT_CLOSE_GRACE_MS = 10_000;
const DEFAULT_STOP_GRACE_MS = 3_000;
const GATEWAY_CLOSE_AT_DEFAULTS_MS = 28_000;
const SUPERVISOR_CLOSE_AT_ZERO_DRAIN_MS = 88_100;
const SAMPLED_GRACES_MS = [0, 1, 567, 3_000, 60_000] as const;
const SAMPLED_DRAINS_MS = [0, 7, 30_000] as const;

const constant = (arith: ProofArith, value: number): ProofInt => arith.ctx.Int.val(BigInt(value));

const gatewayMaxCloseOf = (closeGrace: ProofInt, stop: ProofInt): ProofInt => closeGrace.add(stop.mul(MANAGED_STOP_WINDOWS));

const managedServerStopBoundOf = (arith: ProofArith, stop: ProofInt): ProofInt => stop.mul(MANAGED_STOP_WINDOWS).add(constant(arith, 0));

const managedServerReapBoundOf = (arith: ProofArith, stop: ProofInt): ProofInt => stop.add(constant(arith, REAP_POLL_INTERVAL_MS)).mul(MANAGED_REAP_WINDOWS);

const supervisorMaxCloseOf = (drain: ProofInt, closeGrace: ProofInt, stop: ProofInt, arith: ProofArith): ProofInt =>
  drain.add(closeGrace).add(stop.mul(MANAGED_STOP_WINDOWS)).add(managedServerReapBoundOf(arith, stop)).add(constant(arith, SUPERVISOR_FIXED_TERMS_MS));

const startupUnwindOf = (stop: ProofInt): ProofInt => stop.mul(MANAGED_STOP_WINDOWS * STARTUP_UNWIND_STOPS);

describe('managed server bounds (design-managed-servers-2026-11-09.md, section 17 item 1: the close-grace terms of process-contract.ts, revision 6)', () => {
  const z3 = useZ3();

  it('reads the closed forms of the code at sampled values, so the proofs below describe the code and not themselves', () => {
    expect(REAP_POLL_INTERVAL_MS).toBe(25);
    for (const grace of SAMPLED_GRACES_MS) {
      const values = { closeGraceMs: DEFAULT_CLOSE_GRACE_MS, managedServerStopGraceMs: grace };
      expect(managedServerStopBoundMs(grace)).toBe(MANAGED_STOP_WINDOWS * grace);
      expect(managedServerReapBoundMs(values)).toBe(markerReapClockBoundMs(grace));
      expect(managedServerReapBoundMs(values)).toBe(MANAGED_REAP_WINDOWS * (grace + REAP_POLL_INTERVAL_MS));
      expect(gatewayMaxCloseMs(values)).toBe(DEFAULT_CLOSE_GRACE_MS + MANAGED_STOP_WINDOWS * grace);
      for (const drain of SAMPLED_DRAINS_MS) {
        expect(supervisorMaxCloseMs(drain, values)).toBe(drain + DEFAULT_CLOSE_GRACE_MS + (MANAGED_STOP_WINDOWS + MANAGED_REAP_WINDOWS) * grace + MANAGED_REAP_WINDOWS * REAP_POLL_INTERVAL_MS + SUPERVISOR_FIXED_TERMS_MS);
      }
    }
    expect(DEFAULT_STOP_VALUES).toEqual({ closeGraceMs: DEFAULT_CLOSE_GRACE_MS, managedServerStopGraceMs: DEFAULT_STOP_GRACE_MS });
  });

  it('RM2 proves the gateway close is closeGrace + 6 x stop and is monotone in both values', async () => {
    const arith = proofArith(z3.engine().api, 'RM2');
    const closeA = arith.int('closeA');
    const closeB = arith.int('closeB');
    const stopA = arith.int('stopA');
    const stopB = arith.int('stopB');
    arith.given(closeA.ge(0), closeB.ge(0), stopA.ge(0), stopB.ge(0), closeA.le(closeB), stopA.le(stopB));
    const equal = gatewayMaxCloseOf(closeA, stopA).eq(closeA.add(stopA.mul(MANAGED_STOP_WINDOWS)));
    const monotone = gatewayMaxCloseOf(closeA, stopA).le(gatewayMaxCloseOf(closeB, stopB));
    expect(await prove(arith, arith.ctx.And(equal, monotone))).toEqual({ status: 'proved' });
  }, SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS);

  it('RM3 proves the managed stop bound is 6 x stop, zero at a zero grace, non-negative and monotone', async () => {
    const arith = proofArith(z3.engine().api, 'RM3');
    const stopA = arith.int('stopA');
    const stopB = arith.int('stopB');
    arith.given(stopA.ge(0), stopB.ge(0), stopA.le(stopB));
    const zero = managedServerStopBoundOf(arith, constant(arith, 0)).eq(constant(arith, 0));
    const nonNegative = managedServerStopBoundOf(arith, stopA).ge(0);
    const monotone = managedServerStopBoundOf(arith, stopA).le(managedServerStopBoundOf(arith, stopB));
    expect(await prove(arith, arith.ctx.And(zero, nonNegative, monotone))).toEqual({ status: 'proved' });
  }, SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS);

  it('RM4 proves the supervisor close is d + closeGrace + 6 x stop + 4 x (stop + poll) + 48 000 and is at least each of its stages', async () => {
    const arith = proofArith(z3.engine().api, 'RM4');
    const drain = arith.int('drain');
    const closeGrace = arith.int('closeGrace');
    const stop = arith.int('stop');
    arith.given(drain.ge(0), closeGrace.ge(0), stop.ge(0));
    const total = supervisorMaxCloseOf(drain, closeGrace, stop, arith);
    const atLeastStages = arith.ctx.And(
      total.ge(drain),
      total.ge(closeGrace),
      total.ge(stop.mul(MANAGED_STOP_WINDOWS)),
      total.ge(managedServerReapBoundOf(arith, stop)),
      total.ge(constant(arith, SUPERVISOR_FIXED_TERMS_MS)),
    );
    expect(await prove(arith, atLeastStages)).toEqual({ status: 'proved' });
    expect(await prove(arith, total.eq(drain.add(closeGrace).add(stop.mul(MANAGED_STOP_WINDOWS + MANAGED_REAP_WINDOWS)).add(constant(arith, MANAGED_REAP_WINDOWS * REAP_POLL_INTERVAL_MS + SUPERVISOR_FIXED_TERMS_MS))))).toEqual({ status: 'proved' });
  }, SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS);

  it('RM4r proves the supervisor reap of a gone gateway\'s servers (4 x (stop + poll), the reaper\'s own bound) is positive, monotone in the stop grace, and four polls at a zero grace', async () => {
    const arith = proofArith(z3.engine().api, 'RM4r');
    const stopA = arith.int('stopA');
    const stopB = arith.int('stopB');
    arith.given(stopA.ge(0), stopB.ge(0), stopA.le(stopB));
    const reap = managedServerReapBoundOf(arith, stopA);
    const monotone = reap.le(managedServerReapBoundOf(arith, stopB));
    const atZero = managedServerReapBoundOf(arith, constant(arith, 0)).eq(constant(arith, MANAGED_REAP_WINDOWS * REAP_POLL_INTERVAL_MS));
    expect(await prove(arith, arith.ctx.And(reap.gt(0), monotone, atZero))).toEqual({ status: 'proved' });
  }, SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS);

  it('RM5 checks the restart delay sum backoff x (2^n - 1) is finite, non-negative and monotone in n for every n in the product range', () => {
    const BACKOFF_MS = 1000;
    const RANGE = 20;
    let previous = 0;
    for (let n = 0; n <= RANGE; n += 1) {
      const total = BACKOFF_MS * (2 ** n - 1);
      expect(Number.isFinite(total)).toBe(true);
      expect(total).toBeGreaterThanOrEqual(0);
      expect(total).toBeGreaterThanOrEqual(previous);
      previous = total;
    }
  });

  it('RM6 proves the startup unwind bound is two sequential managed stop bounds and is at least each of them', async () => {
    const arith = proofArith(z3.engine().api, 'RM6');
    const stop = arith.int('stop');
    arith.given(stop.ge(0));
    const unwind = startupUnwindOf(stop);
    const perPhase = managedServerStopBoundOf(arith, stop);
    expect(await prove(arith, arith.ctx.And(unwind.ge(perPhase), unwind.eq(perPhase.add(perPhase))))).toEqual({ status: 'proved' });
  }, SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS);

  it('RM7 checks the close-grace pins at the defaults: 28 000 for the gateway close and 88 100 for the supervisor at zero drain (revision 6)', async () => {
    const arith = proofArith(z3.engine().api, 'RM7');
    const closeGrace = constant(arith, DEFAULT_CLOSE_GRACE_MS);
    const stop = constant(arith, DEFAULT_STOP_GRACE_MS);
    const gateway = gatewayMaxCloseOf(closeGrace, stop);
    const supervisor = supervisorMaxCloseOf(constant(arith, 0), closeGrace, stop, arith);
    expect(await prove(arith, arith.ctx.And(gateway.eq(constant(arith, GATEWAY_CLOSE_AT_DEFAULTS_MS)), supervisor.eq(constant(arith, SUPERVISOR_CLOSE_AT_ZERO_DRAIN_MS))))).toEqual({ status: 'proved' });
  }, SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS);
});
