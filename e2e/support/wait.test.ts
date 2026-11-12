import { describe, expect, it } from 'vitest';
import { RULE_VERIFY_BUDGET_MS } from '@momonga/protocol';
import { REFLECTION_PICKUP_BOUND_MS } from '@momonga/runtime';
import * as waits from './wait.ts';
import { DEFAULT_LEASE_MS } from '../../packages/runtime/src/process/start-runtime-process.ts';
import { DEFAULT_STOP_VALUES, ENTRY_HARD_EXIT_MARGIN_MS, gatewayMaxCloseMs, runtimeMaxCloseMs, supervisorMaxCloseMs } from '@momonga/foundation';
import { SETTINGS_DEBOUNCE_MS, SETTINGS_POLL_MS, SHUTDOWN_RELEASE_BOUND_MS } from '@momonga/supervisor';
import { CANCEL_UPSTREAM_SETTLE_MS, GATEWAY_CANCEL_TIMEOUT_MS, SANDBOX_KILL_GRACE_MS } from '../../packages/runtime/src/process/constants.ts';
import {
  E2E_CANCEL_KILL_BOUND_MS,
  E2E_CANCEL_STREAM_BOUND_MS,
  E2E_CANCEL_TERM_BOUND_MS,
  E2E_DISPOSE_BOUND_MS,
  E2E_HOOK_TIMEOUT_MS,
  E2E_MARGIN_MS,
  E2E_RESTART_BACKOFF_MS,
  E2E_STOP_VALUES,
  E2E_LEASE_MS,
  E2E_ORPHAN_CLOSE_BOUND_MS,
  E2E_ORPHAN_GRACE_MS,
  E2E_PHASE2_REACHED_BOUND_MS,
  E2E_READY_DEADLINE_MS,
  E2E_REAP_TO_RUNNING_BOUND_MS,
  E2E_RECOVERY_BOUND_MS,
  E2E_REAP_CLOSE_BOUND_MS,
  E2E_RESTART_BOUND_MS,
  E2E_RESTART_POLICY,
  E2E_SETTINGS_RESTART_BOUND_MS,
  E2E_SETTINGS_SEEN_BOUND_MS,
  E2E_SUPERVISOR_CLOSE_BOUND_MS,
  E2E_TEST_TIMEOUT_MS,
  E2E_TEST_WAIT_BOUNDS_MS,
  e2eTestTimeoutMs,
  E2E_LONGEST_WAIT_MS,
  abortableWait,
  e2eStartBoundMs,
  until,
  withinBound,
} from './wait.ts';
import { ORPHAN_POLL_MS, STARTUP_TIMEOUT_MS, STDIO_FLUSH_MS, childRestartBoundMs, orphanPhaseOneBoundMs, resolveRestartPolicy } from '@momonga/supervisor';

const UNTIL_TEST_DEADLINE_MS = 200;

describe('wait constants', () => {
  it('derive the bounds of §9.1 from the product constants', () => {
    expect(E2E_RECOVERY_BOUND_MS).toBe(E2E_RESTART_BOUND_MS + E2E_LEASE_MS + E2E_MARGIN_MS);
    expect(E2E_SETTINGS_SEEN_BOUND_MS).toBe(SETTINGS_DEBOUNCE_MS + SETTINGS_POLL_MS + E2E_MARGIN_MS);
    expect(E2E_SETTINGS_RESTART_BOUND_MS).toBe(SETTINGS_DEBOUNCE_MS + SETTINGS_POLL_MS + 2 * E2E_RESTART_BOUND_MS);
    expect(E2E_ORPHAN_CLOSE_BOUND_MS).toBe(Math.max(runtimeMaxCloseMs(E2E_STOP_VALUES), gatewayMaxCloseMs(E2E_STOP_VALUES)) + E2E_MARGIN_MS);
    expect(E2E_SUPERVISOR_CLOSE_BOUND_MS).toBe(supervisorMaxCloseMs(E2E_STOP_VALUES) + ENTRY_HARD_EXIT_MARGIN_MS + E2E_MARGIN_MS);
    expect(E2E_STOP_VALUES).toEqual(DEFAULT_STOP_VALUES);
    expect(E2E_LEASE_MS).toBe(DEFAULT_LEASE_MS);
    expect(E2E_REAP_CLOSE_BOUND_MS).toBe(SHUTDOWN_RELEASE_BOUND_MS + E2E_MARGIN_MS);
    expect(E2E_CANCEL_TERM_BOUND_MS).toBe(E2E_MARGIN_MS);
    expect(E2E_CANCEL_KILL_BOUND_MS).toBe(SANDBOX_KILL_GRACE_MS + E2E_MARGIN_MS);
    expect(E2E_CANCEL_STREAM_BOUND_MS).toBe(GATEWAY_CANCEL_TIMEOUT_MS + CANCEL_UPSTREAM_SETTLE_MS + E2E_MARGIN_MS);
    expect(E2E_RESTART_POLICY).toEqual({ baseMs: E2E_RESTART_BACKOFF_MS, maxMs: E2E_RESTART_BACKOFF_MS, minMs: E2E_RESTART_BACKOFF_MS });
    expect(E2E_REAP_TO_RUNNING_BOUND_MS).toBe(e2eStartBoundMs({}));
  });

  it('wait for a restarted child exactly as long as the supervisor of the e2e stack promises', () => {
    expect(E2E_RESTART_BOUND_MS).toBe(childRestartBoundMs({ policy: resolveRestartPolicy(E2E_RESTART_POLICY), startupTimeoutMs: STARTUP_TIMEOUT_MS, stdioFlushMs: STDIO_FLUSH_MS }));
  });

  it('wait for a stack to start exactly as long as the supervisor of the default e2e stack promises', () => {
    expect(E2E_READY_DEADLINE_MS).toBe(e2eStartBoundMs({}));
  });

  it('wait for phase 2 of the orphan reap exactly as long as phase 1 of the short-grace e2e supervisor lasts, plus the observer margin', () => {
    expect(E2E_PHASE2_REACHED_BOUND_MS).toBe(orphanPhaseOneBoundMs({ orphanGraceMs: E2E_ORPHAN_GRACE_MS, orphanPollMs: ORPHAN_POLL_MS, predecessorStopValues: E2E_STOP_VALUES }) + E2E_MARGIN_MS);
  });

  it('give a test the sum of the bounds it waits on in sequence, plus the observer margin', () => {
    expect(e2eTestTimeoutMs()).toBe(E2E_MARGIN_MS);
    expect(e2eTestTimeoutMs(E2E_READY_DEADLINE_MS, E2E_RESTART_BOUND_MS)).toBe(E2E_READY_DEADLINE_MS + E2E_RESTART_BOUND_MS + E2E_MARGIN_MS);
  });

  it('give the common test, a stack start, its longest single wait and the shutdown barrier, their sum', () => {
    expect(E2E_TEST_TIMEOUT_MS).toBe(e2eTestTimeoutMs(E2E_READY_DEADLINE_MS, E2E_LONGEST_WAIT_MS, E2E_SUPERVISOR_CLOSE_BOUND_MS));
  });

  it('keep every wait a test makes below the test timeout, so a broken promise fails with its own description', () => {
    for (const [name, boundMs] of Object.entries(E2E_TEST_WAIT_BOUNDS_MS)) expect(boundMs, name).toBeLessThan(E2E_TEST_TIMEOUT_MS);
  });

  it('keep the dispose budget below the hook timeout', () => {
    expect(E2E_DISPOSE_BOUND_MS).toBeLessThan(E2E_HOOK_TIMEOUT_MS);
  });
});

describe('until', () => {
  it('resolves with the first truthy value of the predicate', async () => {
    let calls = 0;
    const value = await until(() => {
      calls += 1;
      return calls >= 3 ? { calls } : undefined;
    }, { deadlineMs: 5000, intervalMs: 1, description: 'third call' });
    expect(value).toEqual({ calls: 3 });
    expect(calls).toBe(3);
  });

  it('treats a throwing predicate as not yet', async () => {
    let calls = 0;
    const value = await until(async () => {
      calls += 1;
      if (calls < 3) throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
      return 'up';
    }, { deadlineMs: 5000, intervalMs: 1, description: 'socket up' });
    expect(value).toBe('up');
    expect(calls).toBe(3);
  });

  it('rejects at the deadline with the description and the last thrown error', async () => {
    let calls = 0;
    const failure = await until(() => {
      calls += 1;
      throw new Error(`ENOENT attempt ${calls}`);
    }, { deadlineMs: UNTIL_TEST_DEADLINE_MS, intervalMs: 5, description: 'runtime.sock reachable' }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).toContain('runtime.sock reachable');
    expect(message).toContain(`ENOENT attempt ${calls}`);
    expect(calls).toBeGreaterThan(1);
  });

  it('rejects at the deadline with the description when the predicate stays falsy', async () => {
    await expect(until(() => false, { deadlineMs: UNTIL_TEST_DEADLINE_MS, intervalMs: 5, description: 'never true' })).rejects.toThrow('never true');
  });
});

describe('abortableWait', () => {
  it('resolves once the time has passed, with or without a signal', async () => {
    await expect(abortableWait(1)).resolves.toBeUndefined();
    await expect(abortableWait(1, new AbortController().signal)).resolves.toBeUndefined();
  });

  it('rejects with the reason of the signal when it is aborted while waiting', async () => {
    const controller = new AbortController();
    const reason = new Error('stop waiting');
    const waiting = abortableWait(60_000, controller.signal);
    controller.abort(reason);
    await expect(waiting).rejects.toBe(reason);
  });

  it('rejects with the reason of a signal that is already aborted', async () => {
    const controller = new AbortController();
    const reason = new Error('already stopped');
    controller.abort(reason);
    await expect(abortableWait(60_000, controller.signal)).rejects.toBe(reason);
  });
});

describe('withinBound', () => {
  it('resolves with the value of a promise that settles inside the bound', async () => {
    await expect(withinBound(Promise.resolve('settled'), UNTIL_TEST_DEADLINE_MS, 'the settled promise')).resolves.toBe('settled');
  });

  it('passes the rejection of a promise that fails inside the bound through unchanged', async () => {
    const failure = new Error('inner failure');
    const rejected = Promise.reject(failure);
    rejected.catch(() => undefined);
    await expect(withinBound(rejected, UNTIL_TEST_DEADLINE_MS, 'the failing promise')).rejects.toBe(failure);
  });

  it('rejects naming the description and the bound when the promise does not settle in time', async () => {
    const pending = new Promise<never>(() => undefined);
    await expect(withinBound(pending, 10, 'the pending promise')).rejects.toThrow('the pending promise did not happen within 10 ms');
  });
});

describe('the bounds a test waits on', () => {
  it('are all in the one list the test timeout is computed from', () => {
    const listed = new Set(Object.keys(waits.E2E_TEST_WAIT_BOUNDS_MS));
    const exported = Object.keys(waits).filter((name) => name.endsWith('_BOUND_MS') && !['E2E_DISPOSE_BOUND_MS'].includes(name));
    expect(exported.filter((name) => !listed.has(name))).toEqual([]);
  });

  it('wait for the sweeper reflection as long as one pickup and one attempt of the e2e stack, which answers like a run', () => {
    expect(waits.E2E_REFLECTION_SETTLED_BOUND_MS).toBe(REFLECTION_PICKUP_BOUND_MS + waits.E2E_RUN_COMPLETED_BOUND_MS);
    expect(waits.E2E_REFLECTION_SETTLED_BOUND_MS).toBeLessThan(waits.E2E_TEST_TIMEOUT_MS);
  });

  it('give a run that verifies its rules the rule verify budget', () => {
    expect(waits.E2E_RUN_COMPLETED_BOUND_MS).toBe(waits.E2E_RECOVERY_BOUND_MS + RULE_VERIFY_BUDGET_MS + waits.E2E_MARGIN_MS);
  });
});
