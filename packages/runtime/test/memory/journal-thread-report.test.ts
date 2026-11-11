import fs from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { buildRunReport } from '@momonga/observability';
import { openDatabase, BUSY_WAIT_LIMIT_MS } from '@momonga/foundation';
import type { RunEventPayload } from '@momonga/protocol';
import { createJournalReader } from '@momonga/store';
import { startJournalThread } from '../../src/memory/journal-thread-client.ts';
import { reportHandler } from '../../src/memory/journal-thread.ts';
import { JOURNAL_THREAD_SILENCE_LIMIT_MS } from '../../src/memory/journal-thread-limits.ts';
import { makeEnv } from '../worker/harness.ts';
import { testKernelLock } from '@momonga/testkit';

vi.setConfig({ testTimeout: 60_000 });

const asPayload = (value: Record<string, unknown>): RunEventPayload => value as unknown as RunEventPayload;

const work = (now: number): RunEventPayload[] => [
  asPayload({ type: 'run.started', attempt: 1, now, pins: { model: 'fm', mandate: { completion: { conditions: [{ id: 'c-test', command: 'npm test', when: 'always', source: 'request' }], requirements: [] } } }, mode: 'manual' }),
  asPayload({ type: 'model.requested', step: 1, attempt: 1, digest: 'd1', body: { input: ['x'.repeat(4000)] } }),
  asPayload({ type: 'tool.call', callId: 'w1', providerCallId: 'w1', name: 'Write', kind: 'edit', sideEffect: 'write', title: 'Write', rawInput: { file_path: '/w/a.txt' } }),
  asPayload({ type: 'tool.started', callId: 'w1', idemKey: 'k-w1', basis: 'rule' }),
  asPayload({ type: 'tool.completed', callId: 'w1', status: 'completed', output: 'ok', files: [{ path: '/w/a.txt', sha256: 'a'.repeat(64), access: 'write' }] }),
  asPayload({ type: 'notice', level: 'info', message: 'the last event of the run is not one the report folds' }),
];

describe('the report request of the journal thread', () => {
  it('answers with the report buildRunReport gives for every event of the run, and the lastSeq it read', async () => {
    const env = await makeEnv();
    const run = await env.enqueue('Work', { history: 'fresh', limits: { maxSteps: 7, maxTotalTokens: 90_000, maxCostUsd: 9.1 } });
    await env.seed(run.id, work(env.clock.now()), 'hold');
    env.clock.advance(250);
    const stored = env.run(run.id);
    const expected = {
      ...buildRunReport(env.events(run.id)),
      budget: {
        limits: { maxSteps: 7, maxTotalTokens: 90_000, maxCostNano: 9_100_000_000, deadlineAt: stored.deadlineAt },
        spent: { steps: stored.step, totalTokens: 0, costNano: 0, unpricedCalls: 0 },
        reserved: { tokens: 0, costNano: 0 },
      },
    };
    const { dev, ino } = fs.statSync(env.dbPath);
    const thread = await startJournalThread({ busyTimeoutMs: BUSY_WAIT_LIMIT_MS, lock: testKernelLock(), databasePath: env.dbPath, identity: { dev, ino }, silenceLimitMs: JOURNAL_THREAD_SILENCE_LIMIT_MS });

    try {
      expect(await thread.report({ runId: run.id })).toEqual({ lastSeq: env.run(run.id).lastSeq, report: expected });
    } finally {
      await thread.close();
    }
    expect(expected.changes.mutatingCalls).toBe(1);
  });

  it('refuses a request without the id of its run and a run that does not exist', async () => {
    const env = await makeEnv();
    const db = openDatabase(env.dbPath, { busyTimeoutMs: BUSY_WAIT_LIMIT_MS });
    try {
      const handler = reportHandler(db, createJournalReader(db));
      expect(() => handler({}, () => undefined)).toThrow(/runId/);
      expect(() => handler({ runId: 'run-missing' }, () => undefined)).toThrow(/unknown run/);
    } finally {
      db.close();
    }
  });

  it('is what the store answers through journalFacts.report', async () => {
    const env = await makeEnv();
    const run = await env.enqueue('Work', { history: 'fresh' });
    await env.seed(run.id, work(env.clock.now()), 'hold');

    const reply = await env.store.journalFacts.report({ runId: run.id });

    const { budget, ...folded } = reply.report;
    expect(folded).toEqual(buildRunReport(env.events(run.id)));
    expect(budget?.limits.deadlineAt).toBe(env.run(run.id).deadlineAt);
  });
});
