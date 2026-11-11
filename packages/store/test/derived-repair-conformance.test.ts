import { describe, expect, it } from 'vitest';
import { enqueue, harness, newSession, rawDb } from './helpers.ts';
import { redactor, stepEvents } from './search-fixture.ts';

const DRAFT_TABLES = ['search_draft_runs', 'search_draft_steps', 'search_draft_parts', 'search_draft_paths'] as const;

const draftRowsOf = (dbPath: string, runId: string): number[] =>
  DRAFT_TABLES.map((table) => Number(rawDb(dbPath).prepare(`SELECT count(*) AS held FROM ${table} WHERE run_id = ?`).get(runId)?.['held']));

const documentCountOf = (dbPath: string, runId: string): number =>
  Number(rawDb(dbPath).prepare('SELECT count(*) AS held FROM search_docs WHERE run_id = ?').get(runId)?.['held']);

describe('DerivedRepair.tla, the draft deletion of the indexer is an actor of the repair (C17)', () => {
  it('a repair that reads the run after the index deleted its drafts reads and writes no draft (RepairNeverReadsDeleted)', async () => {
    const { store, dbPath } = harness();
    const run = await enqueue(store, newSession(store).id, 'a task with one step');
    const claim = store.claim('worker-draft');
    if (claim?.runId !== run.id) throw new Error(`expected to claim ${run.id}`);
    expect(store.append(claim, stepEvents(1, { text: 'step one says widget', tool: { name: 'Read', path: '/work/a.ts', output: 'content' } })).kind).toBe('ok');
    expect((await store.transition(claim, ['RUNNING'], 'COMPLETED', {})).kind).toBe('ok');

    expect(draftRowsOf(dbPath, run.id).some((held) => held > 0)).toBe(true);
    expect(documentCountOf(dbPath, run.id)).toBe(0);

    expect(await store.search.indexBatch({ limit: 10, redactor, maxChars: 20_000 })).toEqual({ runs: 1 });
    const drafts = draftRowsOf(dbPath, run.id);
    const documents = documentCountOf(dbPath, run.id);
    expect(drafts).toEqual(DRAFT_TABLES.map(() => 0));
    expect(documents).toBeGreaterThan(0);

    await store.hasNoticeCode(run.id, 'after.the.drop');
    expect(draftRowsOf(dbPath, run.id)).toEqual(drafts);
    expect(documentCountOf(dbPath, run.id)).toBe(documents);
    expect(await store.search.indexBatch({ limit: 10, redactor, maxChars: 20_000 })).toEqual({ runs: 0 });
  });
});
