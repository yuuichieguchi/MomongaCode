import fs from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { MAIN_AGENT } from '@momonga/protocol';
import type { RunEventPayload } from '@momonga/protocol';
import { foldRunRecord } from '@momonga/reliability';
import * as storeModule from '@momonga/store';
import { startJournalThread } from '../../src/memory/journal-thread-client.ts';
import { JOURNAL_THREAD_SILENCE_LIMIT_MS } from '../../src/memory/journal-thread-limits.ts';
import { makeEnv } from '../worker/harness.ts';
import { testKernelLock } from '@momonga/testkit';
import { BUSY_WAIT_LIMIT_MS } from '@momonga/foundation';

vi.setConfig({ testTimeout: 60_000 });

const factsRefusedError = (): abstract new (...args: never[]) => Error => {
  const refusal = (storeModule as Record<string, unknown>)['FactsRefusedError'];
  if (typeof refusal !== 'function') throw new Error('@momonga/store does not export FactsRefusedError');
  return refusal as abstract new (...args: never[]) => Error;
};

const responded: RunEventPayload = {
  type: 'model.responded',
  step: 1,
  attempt: 1,
  response: { status: 'completed', output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
};

describe('the runFacts request of the embedded journal thread (P2: the stored facts equal the fold)', () => {
  it('answers with the facts and the call rows foldRunRecord computes over the same journal and the same run row', async () => {
    const env = await makeEnv();
    const run = env.enqueue('Work', { history: 'fresh' });
    const claim = await env.seed(
      run.id,
      [
        { type: 'run.started', attempt: 1, now: env.clock.now(), pins: { model: 'fm' }, mode: 'manual' },
        { type: 'attempt.lost', lastLiveAt: env.clock.now() - 5 },
        { type: 'run.started', attempt: 2, now: env.clock.now(), pins: { model: 'fm' }, mode: 'manual' },
        responded,
      ],
      'hold',
    );
    expect((await env.store.transition(claim, ['RUNNING'], 'COMPLETED')).kind).toBe('ok');
    const { dev, ino } = fs.statSync(env.dbPath);
    const thread = await startJournalThread({ busyTimeoutMs: BUSY_WAIT_LIMIT_MS, lock: testKernelLock(), databasePath: env.dbPath, identity: { dev, ino }, silenceLimitMs: JOURNAL_THREAD_SILENCE_LIMIT_MS });
    try {
      const record = await thread.runFacts(run.id);
      const stored = env.store.getRun(run.id);
      if (stored === undefined) throw new Error('the run is missing');
      const expected = foldRunRecord(env.store.readRunEvents(run.id, 0, 1000), {
        runId: run.id,
        rootRunId: run.id,
        sessionId: stored.sessionId,
        status: storeModule.knownValue(stored.status, `the status of run ${run.id}`),
        createdAt: stored.createdAt,
        limits: {},
        deadlineAt: stored.deadlineAt,
        step: stored.step,
        tokensTotal: stored.usage.totalTokens,
        costNano: 0,
        model: 'fm',
        mode: 'manual',
        agent: MAIN_AGENT,
        origin: stored.origin,
      });
      expect(record).toEqual(expected);
      expect(record.facts.recoveries).toEqual([expect.objectContaining({ cause: 'process_lost', outcome: 'recovered' })]);
    } finally {
      await thread.close();
    }
  });

  it('rejects a run whose journal has no run.started as a fold refusal, so the sweeper records it as unavailable', async () => {
    const FactsRefused = factsRefusedError();
    const env = await makeEnv();
    const run = env.enqueue('Work', { history: 'fresh' });
    const claim = await env.seed(run.id, [responded], 'hold');
    expect((await env.store.transition(claim, ['RUNNING'], 'COMPLETED')).kind).toBe('ok');
    const { dev, ino } = fs.statSync(env.dbPath);
    const thread = await startJournalThread({ busyTimeoutMs: BUSY_WAIT_LIMIT_MS, lock: testKernelLock(), databasePath: env.dbPath, identity: { dev, ino }, silenceLimitMs: JOURNAL_THREAD_SILENCE_LIMIT_MS });
    try {
      const refusal = await thread.runFacts(run.id).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(refusal).toBeInstanceOf(FactsRefused);
      expect(String(refusal)).toMatch(/run.started/);
    } finally {
      await thread.close();
    }
  });

  it('gap A1: a request on a closed client rejects as a JournalThreadError that is not a fold refusal', async () => {
    const FactsRefused = factsRefusedError();
    const env = await makeEnv();
    const run = env.enqueue('Work', { history: 'fresh' });
    const claim = await env.seed(run.id, [{ type: 'run.started', attempt: 1, now: env.clock.now(), pins: { model: 'fm' }, mode: 'manual' }, responded], 'hold');
    expect((await env.store.transition(claim, ['RUNNING'], 'COMPLETED')).kind).toBe('ok');
    const { dev, ino } = fs.statSync(env.dbPath);
    const thread = await startJournalThread({ busyTimeoutMs: BUSY_WAIT_LIMIT_MS, lock: testKernelLock(), databasePath: env.dbPath, identity: { dev, ino }, silenceLimitMs: JOURNAL_THREAD_SILENCE_LIMIT_MS });
    await thread.close();
    const failure = await thread.runFacts(run.id).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(storeModule.JournalThreadError);
    expect(failure).not.toBeInstanceOf(FactsRefused);
  });
});
