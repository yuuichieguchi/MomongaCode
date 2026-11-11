import { describe, expect, it } from 'vitest';
import { createJournalReader, FactsRefusedError } from '@momonga/store';
import { runFactsHandler } from '../../src/memory/journal-thread.ts';
import { cancelToEnd, enqueue, harness, newSession, rawDb } from '../../../store/test/helpers.ts';

const factsOf = (dbPath: string, runId: string) => {
  const db = rawDb(dbPath);
  return runFactsHandler(db, createJournalReader(db))({ kind: 'runFacts', runId }, () => {});
};

describe('the facts of a run with no run.started', () => {
  it('skip a run cancelled before it started: no facts and no refusal', async () => {
    const { store, dbPath } = harness();
    const run = await enqueue(store, newSession(store).id, 'go');
    expect((await cancelToEnd(store, run.id)).status).toBe('CANCELLED');
    expect(await factsOf(dbPath, run.id)).toEqual({ skipped: 'cancelled_before_start' });
  });

  it('still refuse a run that is not cancelled', async () => {
    const { store, dbPath } = harness();
    const run = await enqueue(store, newSession(store).id, 'go');
    expect(() => factsOf(dbPath, run.id)).toThrow(FactsRefusedError);
  });
});
