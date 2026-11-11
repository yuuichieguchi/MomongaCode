import fs from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { BUSY_WAIT_LIMIT_MS } from '@momonga/foundation';
import type { RunEventPayload } from '@momonga/protocol';
import { testKernelLock } from '@momonga/testkit';
import { startJournalThread } from '../../src/memory/journal-thread-client.ts';
import { JOURNAL_THREAD_SILENCE_LIMIT_MS } from '../../src/memory/journal-thread-limits.ts';
import { makeEnv } from '../worker/harness.ts';

vi.setConfig({ testTimeout: 60_000 });

const started = (now: number): RunEventPayload => ({ type: 'run.started', attempt: 1, now, pins: {}, mode: 'manual' });

const threadOn = async (dbPath: string) => {
  const { dev, ino } = fs.statSync(dbPath);
  return startJournalThread({ busyTimeoutMs: BUSY_WAIT_LIMIT_MS, lock: testKernelLock(), databasePath: dbPath, identity: { dev, ino }, silenceLimitMs: JOURNAL_THREAD_SILENCE_LIMIT_MS });
};

describe('a request of the journal thread under a signal', () => {
  it('a report whose signal aborts while it is in flight ends with the abort, and the thread still answers the next request', async () => {
    const env = await makeEnv();
    const run = await env.enqueue('Work', { history: 'fresh' });
    await env.seed(run.id, [started(env.clock.now())], 'hold');
    const thread = await threadOn(env.dbPath);
    try {
      const controller = new AbortController();
      const reason = new Error('the asker went away');
      const asked = thread.report({ runId: run.id }, controller.signal);
      controller.abort(reason);
      await expect(asked).rejects.toBe(reason);
      expect((await thread.report({ runId: run.id })).lastSeq).toBe(env.run(run.id).lastSeq);
      expect((await thread.ping()).threadId).toBeGreaterThan(0);
    } finally {
      await thread.close();
    }
  });

  it('a report asked under a signal that has already aborted ends with the abort and is not sent', async () => {
    const env = await makeEnv();
    const run = await env.enqueue('Work', { history: 'fresh' });
    await env.seed(run.id, [started(env.clock.now())], 'hold');
    const thread = await threadOn(env.dbPath);
    try {
      const reason = new Error('already gone');
      await expect(thread.report({ runId: run.id }, AbortSignal.abort(reason))).rejects.toBe(reason);
      expect((await thread.report({ runId: run.id })).lastSeq).toBe(env.run(run.id).lastSeq);
    } finally {
      await thread.close();
    }
  });
});
