import { describe, expect, it } from 'vitest';
import { DERIVATIONS, REPAIR_PAGE_EVENTS } from '../src/derived-repair.ts';
import { enqueue, harness, newSession, rawDb } from './helpers.ts';
import { appendForeignRunEvent } from './compat/fixtures.ts';

describe('a background catch-up repairs lagging derived records in pages after an upgrade', () => {
  it('catches up a run lagging by three pages without an append or a read, one page per step', async () => {
    const { store, dbPath } = harness();
    const run = await enqueue(store, newSession(store).id, 'task');
    const db = rawDb(dbPath);
    db.exec('BEGIN');
    for (let index = 0; index < 3 * REPAIR_PAGE_EVENTS; index += 1) appendForeignRunEvent(db, run.id, 'notice', { level: 'info', message: `old ${index}`, code: `old.${index}` });
    db.exec('COMMIT');
    const lastSeq = Number(db.prepare('SELECT last_seq FROM runs WHERE id = ?').get(run.id)?.['last_seq']);
    const watermarks = (): number[] => db.prepare('SELECT through_seq FROM derived_through WHERE run_id = ? ORDER BY derivation').all(run.id).map((row) => Number(row['through_seq']));

    const passes: boolean[] = [];
    for (let pass = 0; pass < 3; pass += 1) passes.push(await store.catchUpDerived(1));

    expect(passes).toEqual([false, false, true]);
    expect(watermarks()).toEqual(DERIVATIONS.map(() => lastSeq));
    expect(await store.catchUpDerived(1)).toBe(true);
  });
});
