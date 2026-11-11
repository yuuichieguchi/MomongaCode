import fs from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { BUSY_WAIT_LIMIT_MS } from '@momonga/foundation';
import type { RunEventPayload } from '@momonga/protocol';
import type { ContributionPreparer } from '@momonga/store';
import { testKernelLock } from '@momonga/testkit';
import { startJournalThread } from '../../src/memory/journal-thread-client.ts';
import type { JournalThreadClient } from '../../src/memory/journal-thread-client.ts';
import { JOURNAL_THREAD_SILENCE_LIMIT_MS } from '../../src/memory/journal-thread-limits.ts';
import { openJournal } from '../../src/worker/journal.ts';
import { makeEnv } from './harness.ts';
import { foldedThrough, seedLargeRun } from './large-run.ts';

vi.setConfig({ testTimeout: 600_000 });

const STEPS = 1000;
const NOTICES = 450;

const threadPreparer = (dbPath: () => string): { preparer: ContributionPreparer; client(): Promise<JournalThreadClient>; close(): Promise<void> } => {
  let started: Promise<JournalThreadClient> | undefined;
  const client = (): Promise<JournalThreadClient> => {
    started ??= (() => {
      const databasePath = dbPath();
      const { dev, ino } = fs.statSync(databasePath);
      return startJournalThread({ busyTimeoutMs: BUSY_WAIT_LIMIT_MS, lock: testKernelLock(), databasePath, identity: { dev, ino }, silenceLimitMs: JOURNAL_THREAD_SILENCE_LIMIT_MS });
    })();
    return started;
  };
  return {
    client,
    preparer: {
      measure: async (request, signal) => (await client()).measure(request, signal),
      inheritPlan: async (request, signal) => (await client()).inheritPlan(request, signal),
      inheritedWindow: async (request, signal) => (await client()).inheritedWindow(request, signal),
      verdict: async (request, signal) => (await client()).verdict(request, signal),
      evidence: async (request, signal) => (await client()).evidence(request, signal),
      reflectionInput: async (request, signal) => (await client()).reflectionInput(request, signal),
      fidelity: async (request, signal) => (await client()).fidelity(request, signal),
      report: async (request, signal) => (await client()).report(request, signal),
      runState: async (request, signal) => (await client()).runState(request, signal),
    },
    close: async () => {
      if (started !== undefined) await (await started).close();
    },
  };
};

describe('the run state of a claim of a run of 1000 steps', () => {
  it('is loaded by the journal thread with no event decoded on the loop, and appending to it writes no snapshot', async () => {
    let dbPath = '';
    let decodedRows = 0;
    const thread = threadPreparer(() => dbPath);
    const env = await makeEnv({ mode: 'bypassPermissions', preparer: thread.preparer, onDecode: (rows) => (decodedRows += rows) });
    dbPath = env.dbPath;
    try {
      const { run, claim } = await seedLargeRun(env, STEPS);
      const expected = foldedThrough(env, run, env.run(run.id).lastSeq);
      decodedRows = 0;
      const journal = await openJournal({
        store: env.store,
        claim,
        signal: new AbortController().signal,
        lost: () => {
          throw new Error('the lease of the claim was lost');
        },
      });
      expect(decodedRows).toBe(0);
      expect(journal.state).toEqual(expected);
      expect('snapshot' in journal).toBe(false);
      for (let index = 0; index < NOTICES; index += 50) {
        journal.append(Array.from({ length: 50 }, (_unused, offset): RunEventPayload => ({ type: 'notice', level: 'info', message: `note ${index + offset}` })));
      }
      expect(journal.state.lastSeq).toBe(expected.lastSeq + NOTICES);
      expect(env.raw().prepare('SELECT count(*) AS count FROM snapshots WHERE run_id = ?').get(run.id)?.['count']).toBe(0);
    } finally {
      await thread.close();
    }
  });

  it('a load abandoned while the thread folds it ends with the abort, and the thread answers the next requests', async () => {
    let dbPath = '';
    const thread = threadPreparer(() => dbPath);
    const env = await makeEnv({ mode: 'bypassPermissions', preparer: thread.preparer });
    dbPath = env.dbPath;
    try {
      const { run } = await seedLargeRun(env, STEPS);
      const client = await thread.client();
      const controller = new AbortController();
      const reason = new Error('the claim was stopped');
      const asked = client.runState({ runId: run.id }, controller.signal);
      for (let turn = 0; turn < 50; turn += 1) await Promise.resolve();
      controller.abort(reason);
      await expect(asked).rejects.toBe(reason);
      expect((await client.runState({ runId: run.id })).lastSeq).toBe(env.run(run.id).lastSeq);
      expect((await client.ping()).threadId).toBeGreaterThan(0);
    } finally {
      await thread.close();
    }
  });

  it('a load whose signal has aborted ends with the abort', async () => {
    const env = await makeEnv({ mode: 'bypassPermissions' });
    const run = await env.enqueue('Work', { history: 'fresh' });
    await env.seed(run.id, [{ type: 'run.started', attempt: 1, now: env.clock.now(), pins: {}, mode: 'manual' }], 'hold');
    const reason = new Error('the claim was stopped');
    await expect(env.store.load(run.id, AbortSignal.abort(reason))).rejects.toBe(reason);
  });
});
