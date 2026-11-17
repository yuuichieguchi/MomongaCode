import fs from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { settingsFileLock, systemFileLockPorts } from '@momonga/config';
import { DEFAULT_LOCK_TIMEOUT_MS, LockWaitTimeoutError, momongaLayout } from '@momonga/foundation';
import type { Timing } from '@momonga/foundation';
import { testKernelLock } from '@momonga/testkit';
import { makeTree } from './helpers.ts';

const NEVER = new AbortController().signal;

const holdingTree = (): ReturnType<typeof makeTree> => {
  const tree = makeTree();
  fs.mkdirSync(momongaLayout(tree.home, process.platform, process.env).run, { recursive: true, mode: 0o700 });
  return tree;
};

const manualTiming = () => {
  const timers: { ms: number; fire: () => void }[] = [];
  const timing: Timing = {
    now: () => 0,
    monotonicMs: () => 0,
    setTimeout: (callback, ms) => {
      const timer = { ms, fire: callback };
      timers.push(timer);
      return timer;
    },
    clearTimeout: (handle) => {
      const index = timers.indexOf(handle as (typeof timers)[number]);
      if (index !== -1) timers.splice(index, 1);
    },
  };
  return { timing, timers };
};

describe('settingsFileLock: a second writer in this process waits behind a holder that never releases', () => {
  it('ends the in-process wait at the default bound and never runs its work', async () => {
    const tree = holdingTree();
    const { timing, timers } = manualTiming();
    const lock = settingsFileLock(tree.home, { lock: testKernelLock(), ports: { ...systemFileLockPorts, timing } });
    const file = `${tree.home}/settings.json`;
    let held = false;
    void lock.locked(file, NEVER, () => {
      held = true;
      return new Promise<never>(() => undefined);
    });
    await vi.waitFor(() => expect(held).toBe(true));
    let ran = false;
    const before = timers.length;
    const waiter = lock.locked(file, NEVER, async () => {
      ran = true;
    });
    await vi.waitFor(() => expect(timers.length).toBeGreaterThan(before));
    expect(timers.slice(before).map((timer) => timer.ms)).toEqual([DEFAULT_LOCK_TIMEOUT_MS]);
    timers.slice(before).forEach((timer) => timer.fire());
    await expect(waiter).rejects.toBeInstanceOf(LockWaitTimeoutError);
    expect(ran).toBe(false);
  });

  it('ends the in-process wait at the timeout the caller gives', async () => {
    const tree = holdingTree();
    const { timing, timers } = manualTiming();
    const lock = settingsFileLock(tree.home, { lock: testKernelLock(), ports: { ...systemFileLockPorts, timing }, lockTimeoutMs: 50 });
    const file = `${tree.home}/settings.json`;
    let held = false;
    void lock.locked(file, NEVER, () => {
      held = true;
      return new Promise<never>(() => undefined);
    });
    await vi.waitFor(() => expect(held).toBe(true));
    const before = timers.length;
    const waiter = lock.locked(file, NEVER, async () => undefined);
    await vi.waitFor(() => expect(timers.length).toBeGreaterThan(before));
    expect(timers.slice(before).map((timer) => timer.ms)).toEqual([50]);
    timers.slice(before).forEach((timer) => timer.fire());
    await expect(waiter).rejects.toBeInstanceOf(LockWaitTimeoutError);
  });
});
