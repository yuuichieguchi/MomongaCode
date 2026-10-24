import { describe, expect, it } from 'vitest';
import {
  E2E_CANCEL_KILL_BOUND_MS,
  E2E_CANCEL_STREAM_BOUND_MS,
  E2E_CANCEL_TERM_BOUND_MS,
  E2E_DISPOSE_BOUND_MS,
  E2E_HOOK_TIMEOUT_MS,
  E2E_ORPHAN_CLOSE_BOUND_MS,
  E2E_RECOVERY_BOUND_MS,
  E2E_REAP_CLOSE_BOUND_MS,
  E2E_RESTART_BOUND_MS,
  E2E_RESTART_POLICY,
  E2E_SETTINGS_RESTART_BOUND_MS,
  E2E_SETTINGS_SEEN_BOUND_MS,
  E2E_SUPERVISOR_CLOSE_BOUND_MS,
  E2E_TEST_TIMEOUT_MS,
  until,
  withinBound,
} from './wait.ts';
import { ORPHAN_REAP_GRACE_MS } from '@momonga/supervisor';

const UNTIL_TEST_DEADLINE_MS = 200;

describe('wait constants', () => {
  it('derive the bounds of §9.1 from the product constants', () => {
    expect(E2E_RESTART_BOUND_MS).toBe(5200);
    expect(E2E_RECOVERY_BOUND_MS).toBe(12_200);
    expect(E2E_SETTINGS_SEEN_BOUND_MS).toBe(6200);
    expect(E2E_SETTINGS_RESTART_BOUND_MS).toBe(12_600);
    expect(E2E_ORPHAN_CLOSE_BOUND_MS).toBe(20_000);
    expect(E2E_SUPERVISOR_CLOSE_BOUND_MS).toBe(59_000);
    expect(E2E_REAP_CLOSE_BOUND_MS).toBe(9000);
    expect(E2E_CANCEL_TERM_BOUND_MS).toBe(4000);
    expect(E2E_CANCEL_KILL_BOUND_MS).toBe(5000);
    expect(E2E_CANCEL_STREAM_BOUND_MS).toBe(6000);
    expect(E2E_RESTART_POLICY).toEqual({ baseMs: 200, maxMs: 200, minMs: 200 });
    expect(E2E_TEST_TIMEOUT_MS).toBe(90_000);
  });

  it('keep the dispose budget below the hook timeout and the reap bound below the reap grace', () => {
    expect(E2E_DISPOSE_BOUND_MS).toBeLessThan(E2E_HOOK_TIMEOUT_MS);
    expect(E2E_REAP_CLOSE_BOUND_MS).toBeLessThan(ORPHAN_REAP_GRACE_MS);
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
