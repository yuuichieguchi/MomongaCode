import { describe, expect, it } from 'vitest';
import { harness, rawDb } from './helpers.ts';
import { appendForeignRunEvent } from './compat/fixtures.ts';
import { indexAll, finishedRun } from './search-fixture.ts';

const DRAFT_TABLES = ['search_draft_runs', 'search_draft_steps', 'search_draft_parts', 'search_draft_paths'] as const;

describe('every search draft row has a consumer', () => {
  it('leaves no draft when an older build appends to a run after the run was indexed and this build repairs its records', async () => {
    const { store, dbPath } = harness();
    const run = await finishedRun(store, '/work/a', 'widget task', [{ text: 'widget', tool: { name: 'Read', path: '/work/a/one.ts', output: 'widget one' } }]);
    await indexAll(store);
    const db = rawDb(dbPath);
    db.prepare('UPDATE runs SET step = 1 WHERE id = ?').run(run.id);
    appendForeignRunEvent(db, run.id, 'model.responded', {
      step: 1,
      attempt: 2,
      response: { status: 'completed', output: [{ type: 'message', id: 'late', role: 'assistant', content: [{ type: 'output_text', text: 'late widget' }] }], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
    });

    await store.finalTextOf(run.id);

    for (const table of DRAFT_TABLES) expect({ table, rows: Number(db.prepare(`SELECT count(*) AS held FROM ${table} WHERE run_id = ?`).get(run.id)?.['held']) }).toEqual({ table, rows: 0 });
  });

  it('removes every draft of a run with its last index page', async () => {
    const { store, dbPath } = harness();
    const run = await finishedRun(store, '/work/a', 'widget task', [{ text: 'widget', tool: { name: 'Read', path: '/work/a/one.ts', output: 'widget one' } }]);
    await indexAll(store);
    const db = rawDb(dbPath);
    for (const table of DRAFT_TABLES) expect({ table, rows: Number(db.prepare(`SELECT count(*) AS held FROM ${table} WHERE run_id = ?`).get(run.id)?.['held']) }).toEqual({ table, rows: 0 });
  });
});
