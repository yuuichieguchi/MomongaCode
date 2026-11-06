import fs from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { MAIN_AGENT } from '@momonga/protocol';
import type { RunEventPayload } from '@momonga/protocol';
import { foldFacts } from '@momonga/reliability';
import { startJournalThread } from '../../src/memory/journal-thread-client.ts';
import { JOURNAL_THREAD_SILENCE_LIMIT_MS } from '../../src/memory/journal-thread-limits.ts';
import { makeEnv } from '../worker/harness.ts';

vi.setConfig({ testTimeout: 60_000 });

const responded: RunEventPayload = {
  type: 'model.responded',
  step: 1,
  attempt: 1,
  response: { status: 'completed', output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
};

describe('the runFacts request of the embedded journal thread (P2: the stored facts equal the fold)', () => {
  it('answers with the facts foldFacts computes over the same journal and the same run row', async () => {
    const env = await makeEnv();
    const run = env.enqueue('Work', { history: 'fresh' });
    const claim = env.seed(
      run.id,
      [
        { type: 'run.started', attempt: 1, now: env.clock.now(), pins: { modelAlias: 'fm' }, mode: 'default' },
        { type: 'attempt.lost', lastLiveAt: env.clock.now() - 5 },
        { type: 'run.started', attempt: 2, now: env.clock.now(), pins: { modelAlias: 'fm' }, mode: 'default' },
        responded,
      ],
      'hold',
    );
    expect((await env.store.transition(claim, ['RUNNING'], 'COMPLETED')).kind).toBe('ok');
    const { dev, ino } = fs.statSync(env.dbPath);
    const thread = await startJournalThread({ databasePath: env.dbPath, identity: { dev, ino }, silenceLimitMs: JOURNAL_THREAD_SILENCE_LIMIT_MS });
    try {
      const facts = await thread.runFacts(run.id);
      const stored = env.store.getRun(run.id);
      if (stored === undefined) throw new Error('the run is missing');
      const expected = foldFacts(env.store.readRunEvents(run.id, 0, 1000), {
        runId: run.id,
        rootRunId: run.id,
        sessionId: stored.sessionId,
        status: stored.status,
        createdAt: stored.createdAt,
        limits: {},
        deadlineAt: stored.deadlineAt,
        step: stored.step,
        tokensTotal: stored.usage.totalTokens,
        modelAlias: 'fm',
        mode: 'default',
        agent: MAIN_AGENT,
        origin: stored.origin,
      });
      expect(facts).toEqual(expected);
      expect(facts.recoveries).toEqual([expect.objectContaining({ cause: 'process_lost', outcome: 'recovered' })]);
    } finally {
      await thread.close();
    }
  });

  it('rejects a run whose journal has no run.started, so the sweeper records it as unavailable', async () => {
    const env = await makeEnv();
    const run = env.enqueue('Work', { history: 'fresh' });
    const claim = env.seed(run.id, [responded], 'hold');
    expect((await env.store.transition(claim, ['RUNNING'], 'COMPLETED')).kind).toBe('ok');
    const { dev, ino } = fs.statSync(env.dbPath);
    const thread = await startJournalThread({ databasePath: env.dbPath, identity: { dev, ino }, silenceLimitMs: JOURNAL_THREAD_SILENCE_LIMIT_MS });
    try {
      await expect(thread.runFacts(run.id)).rejects.toThrow(/run.started/);
    } finally {
      await thread.close();
    }
  });
});
