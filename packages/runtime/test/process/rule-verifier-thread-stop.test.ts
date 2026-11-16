import { describe, expect, it, vi } from 'vitest';
import { SOLVER_THREAD_STOP_BOUND_MS } from '@momonga/foundation';
import { systemTimers } from '../../src/service/timers.ts';
import { VerificationThreadNotStoppedError, verifyInThread } from '../../src/process/rule-verifier-thread-client.ts';
import type { RuleVerifyJob } from '../../src/process/rule-verifier-thread.ts';

const stuck = vi.hoisted(() => ({ terminations: 0 }));

vi.mock('node:worker_threads', async (importOriginal) => {
  const { EventEmitter: Emitter } = await import('node:events');
  class NeverStoppingWorker extends Emitter {
    constructor() {
      super();
      setTimeout(() => this.emit('message', { ok: false, reason: 'replied before the stop' }), 1);
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
    const started = Date.now();
    const verifying = verifyInThread({ code: '', timers: systemTimers, startBoundMs: 60_000 }, job, new AbortController().signal);
    await expect(verifying).rejects.toBeInstanceOf(VerificationThreadNotStoppedError);
    await expect(verifying).rejects.toThrow(`the verification thread did not stop within ${SOLVER_THREAD_STOP_BOUND_MS} ms`);
    expect(stuck.terminations).toBe(1);
    expect(Date.now() - started).toBeGreaterThanOrEqual(SOLVER_THREAD_STOP_BOUND_MS);
  }, 4 * SOLVER_THREAD_STOP_BOUND_MS);
});

