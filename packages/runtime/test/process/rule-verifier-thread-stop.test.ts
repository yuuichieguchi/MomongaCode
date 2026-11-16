import { describe, expect, it, vi } from 'vitest';
import { SOLVER_THREAD_STOP_BOUND_MS } from '@momonga/foundation';
import { createFakeClock, createFakeTimers } from '@momonga/testkit';
import { VerificationThreadNotStoppedError, verifyInThread } from '../../src/process/rule-verifier-thread-client.ts';
import type { RuleVerifyJob } from '../../src/process/rule-verifier-thread.ts';

const stuck = vi.hoisted(() => ({ terminations: 0 }));

vi.mock('node:worker_threads', async (importOriginal) => {
  const { EventEmitter: Emitter } = await import('node:events');
  class NeverStoppingWorker extends Emitter {
    constructor() {
      super();
      queueMicrotask(() => this.emit('message', { ok: false, reason: 'replied before the stop' }));
    }
    postMessage(): void {}
    terminate(): Promise<number> {
      stuck.terminations += 1;
      return new Promise<number>(() => undefined);
    }
  }
  return { ...(await importOriginal<typeof import('node:worker_threads')>()), Worker: NeverStoppingWorker };
});

const job = {} as RuleVerifyJob;

describe('the verification thread is stopped within the stated solver thread bound', () => {
  it('fails with VerificationThreadNotStoppedError, naming the bound, when the terminate of the thread does not end within it', async () => {
    const timers = createFakeTimers(createFakeClock(0));
    let failure: unknown;
    const verifying = verifyInThread({ code: '', timers, startBoundMs: 60_000 }, job, new AbortController().signal).catch((error: unknown) => {
      failure = error;
    });
    await vi.waitFor(() => expect(stuck.terminations).toBe(1));
    await timers.advanceAsync(SOLVER_THREAD_STOP_BOUND_MS - 1);
    expect(failure).toBeUndefined();
    await timers.advanceAsync(1);
    await verifying;
    expect(failure).toBeInstanceOf(VerificationThreadNotStoppedError);
    expect(String(failure)).toContain(`the verification thread did not stop within ${SOLVER_THREAD_STOP_BOUND_MS} ms`);
  });
});

