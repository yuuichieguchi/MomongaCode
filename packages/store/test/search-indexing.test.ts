import { describe, expect, it } from 'vitest';
import { createFakeClock } from '@momonga/testkit';
import { START_MS, harness, openStoreAt, rawDb } from './helpers.ts';
import { finishedRun, openRun, redactor } from './search-fixture.ts';

const STEP = { text: 'said', tool: { name: 'Read', path: '/work/a/f.ts', output: 'recorded' } };

const cursorOf = (dbPath: string): number => Number(rawDb(dbPath).prepare('SELECT last_event_id FROM search_cursor').get()?.['last_event_id']);

const indexedRuns = (dbPath: string): string[] =>
  rawDb(dbPath).prepare("SELECT run_id FROM search_docs WHERE level = 'run' ORDER BY id").all().map((row) => String(row['run_id']));

const duplicateDocs = (dbPath: string): number =>
  rawDb(dbPath).prepare('SELECT count(*) AS copies FROM search_docs GROUP BY run_id, level, step HAVING copies > 1').all().length;

const docCountOf = (dbPath: string, runId: string): number =>
  Number(rawDb(dbPath).prepare('SELECT count(*) AS docs FROM search_docs WHERE run_id = :runId').get({ runId })?.['docs']);

describe('search indexing', () => {
  it('indexes at most the batch limit, oldest terminal run first, and stores its cursor', () => {
    const { store, dbPath } = harness();
    const runs = [finishedRun(store, '/work/a', 'one', [STEP]), finishedRun(store, '/work/a', 'two', [STEP]), finishedRun(store, '/work/a', 'three', [STEP])];
    expect(store.search.indexBatch({ limit: 2, redactor })).toEqual({ runs: 2 });
    expect(indexedRuns(dbPath)).toEqual([runs[0]?.id, runs[1]?.id]);
    const firstCursor = cursorOf(dbPath);
    expect(firstCursor).toBeGreaterThan(0);
    expect(store.search.indexBatch({ limit: 2, redactor })).toEqual({ runs: 1 });
    expect(indexedRuns(dbPath)).toEqual(runs.map((run) => run.id));
    expect(cursorOf(dbPath)).toBeGreaterThan(firstCursor);
    expect(store.search.indexBatch({ limit: 2, redactor })).toEqual({ runs: 0 });
    expect(duplicateDocs(dbPath)).toBe(0);
  });

  it('skips runs that have not ended', () => {
    const { store, dbPath } = harness();
    const { run } = openRun(store, '/work/a', 'running', [STEP]);
    expect(store.search.indexBatch({ limit: 10, redactor })).toEqual({ runs: 0 });
    expect(docCountOf(dbPath, run.id)).toBe(0);
  });

  it('indexes every terminal status', () => {
    const { store, dbPath } = harness();
    const runs = [finishedRun(store, '/work/a', 'a', [], 'COMPLETED'), finishedRun(store, '/work/a', 'b', [], 'FAILED'), finishedRun(store, '/work/a', 'c', [], 'CANCELLED')];
    store.search.indexBatch({ limit: 10, redactor });
    expect(indexedRuns(dbPath)).toEqual(runs.map((run) => run.id));
  });

  it('indexes a run that was queued and cancelled before any worker claimed it', () => {
    const { store, dbPath } = harness();
    const session = store.createSession({ cwd: '/work/a', env: {}, permissionMode: 'default', modelAlias: 'fm' });
    const created = store.createRunAndEnqueue(session.id, { input: 'never started', timeoutMs: 1000, limits: {}, pins: {} });
    if (created.kind !== 'created') throw new Error(created.kind);
    store.requestCancel(created.run.id);
    expect(store.getRun(created.run.id)?.status).toBe('CANCELLED');
    store.search.indexBatch({ limit: 10, redactor });
    expect(indexedRuns(dbPath)).toEqual([created.run.id]);
  });

  it('backfills runs that ended before the first batch and earlier sessions', () => {
    const { store, dbPath } = harness();
    const early = finishedRun(store, '/work/a', 'early', [STEP]);
    const other = finishedRun(store, '/work/b', 'other project', [STEP]);
    expect(cursorOf(dbPath)).toBe(0);
    store.search.indexBatch({ limit: 10, redactor });
    expect(indexedRuns(dbPath)).toEqual([early.id, other.id]);
  });

  it('still indexes a run that started before others and ended after the cursor passed them', () => {
    const { store, dbPath } = harness();
    const late = openRun(store, '/work/a', 'slow', [STEP]);
    const quick = finishedRun(store, '/work/b', 'quick', [STEP]);
    store.search.indexBatch({ limit: 10, redactor });
    expect(indexedRuns(dbPath)).toEqual([quick.id]);
    late.finish();
    expect(store.search.indexBatch({ limit: 10, redactor })).toEqual({ runs: 1 });
    expect(indexedRuns(dbPath)).toEqual([quick.id, late.run.id]);
    expect(duplicateDocs(dbPath)).toBe(0);
  });

  it('resumes from the stored cursor after a restart between batches, losing and duplicating nothing', () => {
    const { store, dbPath } = harness();
    const runs = [finishedRun(store, '/work/a', 'one', [STEP]), finishedRun(store, '/work/a', 'two', [STEP]), finishedRun(store, '/work/a', 'three', [STEP])];
    store.search.indexBatch({ limit: 1, redactor });
    store.close();
    const reopened = openStoreAt(dbPath, createFakeClock(START_MS + 1000));
    while (reopened.search.indexBatch({ limit: 1, redactor }).runs > 0);
    expect(indexedRuns(dbPath)).toEqual(runs.map((run) => run.id));
    expect(duplicateDocs(dbPath)).toBe(0);
  });

  it('leaves every run whole after a failure inside a batch, and the retry finishes without copies', () => {
    const { store, dbPath } = harness();
    const first = finishedRun(store, '/work/a', 'one', [STEP]);
    const second = finishedRun(store, '/work/a', 'two', [STEP]);
    const db = rawDb(dbPath);
    db.exec(`CREATE TRIGGER crash_on_second BEFORE INSERT ON search_docs WHEN NEW.run_id = '${second.id}' AND NEW.level = 'run' BEGIN SELECT RAISE(ABORT, 'simulated crash'); END`);
    expect(() => store.search.indexBatch({ limit: 2, redactor })).toThrow(/simulated crash/);
    const partial = docCountOf(dbPath, second.id);
    expect(partial).toBe(0);
    db.exec('DROP TRIGGER crash_on_second');
    while (store.search.indexBatch({ limit: 2, redactor }).runs > 0);
    expect(indexedRuns(dbPath).sort()).toEqual([first.id, second.id].sort());
    expect(duplicateDocs(dbPath)).toBe(0);
    expect(docCountOf(dbPath, second.id)).toBe(docCountOf(dbPath, first.id));
  });
});
