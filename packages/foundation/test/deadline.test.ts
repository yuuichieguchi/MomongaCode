import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Deadline } from '@momonga/foundation';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Deadline', () => {
  it('counts down remaining time', () => {
    const deadline = Deadline.after(1000);
    expect(deadline.remainingMs()).toBe(1000);
    vi.advanceTimersByTime(400);
    expect(deadline.remainingMs()).toBe(600);
    expect(deadline.expired).toBe(false);
  });

  it('expires exactly at the deadline and never reports negative remaining time', () => {
    const deadline = Deadline.after(1000);
    vi.advanceTimersByTime(999);
    expect(deadline.expired).toBe(false);
    expect(deadline.signal.aborted).toBe(false);
    vi.advanceTimersByTime(1);
    expect(deadline.expired).toBe(true);
    expect(deadline.signal.aborted).toBe(true);
    vi.advanceTimersByTime(500);
    expect(deadline.remainingMs()).toBe(0);
  });

  it('gives a child the smaller of its own timeout and the parent remaining time', () => {
    const parent = Deadline.after(1000);
    vi.advanceTimersByTime(400);
    expect(parent.child(300).remainingMs()).toBe(300);
    expect(parent.child(10_000).remainingMs()).toBe(600);
  });

  it('aborts a short child before its parent', () => {
    const parent = Deadline.after(1000);
    const child = parent.child(200);
    vi.advanceTimersByTime(200);
    expect(child.signal.aborted).toBe(true);
    expect(child.expired).toBe(true);
    expect(parent.signal.aborted).toBe(false);
  });

  it('aborts a long child when the parent expires', () => {
    const parent = Deadline.after(500);
    const child = parent.child(10_000);
    vi.advanceTimersByTime(499);
    expect(child.signal.aborted).toBe(false);
    vi.advanceTimersByTime(1);
    expect(parent.signal.aborted).toBe(true);
    expect(child.signal.aborted).toBe(true);
    expect(child.expired).toBe(true);
  });

  it('aborts grandchildren through the chain', () => {
    const root = Deadline.after(300);
    const grandchild = root.child(5000).child(5000);
    vi.advanceTimersByTime(300);
    expect(grandchild.signal.aborted).toBe(true);
  });

  it('dispose clears the pending timer so the deadline never expires', () => {
    const deadline = Deadline.after(1000);
    expect(vi.getTimerCount()).toBe(1);
    deadline.dispose();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(5000);
    expect(deadline.expired).toBe(false);
  });

  it('dispose removes the listener from the parent signal and is idempotent', () => {
    const parent = Deadline.after(1000);
    const removed = vi.spyOn(parent.signal, 'removeEventListener');
    const child = parent.child(500);
    expect(vi.getTimerCount()).toBe(2);
    child.dispose();
    child.dispose();
    expect(removed).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(vi.getTimerCount()).toBe(1);
    parent.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
});
