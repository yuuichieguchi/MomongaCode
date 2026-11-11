import { describe, expect, it } from 'vitest';
import { enqueue, harness, mustRun, newSession, rawDb } from '../helpers.ts';
import { recordNewerMigration } from './fixtures.ts';

describe('cancelling a parent whose child holds a status this build does not know (11.4)', () => {
  it('cancels the parent and leaves the child untouched', async () => {
    const { store, dbPath } = harness();
    const parent = await enqueue(store, newSession(store).id);
    const created = await store.createChildRun({ parentRunId: parent.id, parentCallId: 'call_child', input: 'Child', pins: {}, model: 'fm' });
    if (created.kind !== 'created') throw new Error(`expected a child, got ${created.kind}`);
    const db = rawDb(dbPath);
    recordNewerMigration(db);
    db.exec('PRAGMA ignore_check_constraints = ON');
    db.prepare("UPDATE runs SET status = 'PAUSED' WHERE id = ?").run(created.run.id);
    db.close();
    const childSeq = mustRun(store, created.run.id).lastSeq;

    expect((await store.requestCancel(parent.id)).kind).toBe('ok');
    expect(mustRun(store, parent.id).status).toBe('CANCELLING');
    expect(mustRun(store, created.run.id).status).toBe('unknown');
    expect(mustRun(store, created.run.id).lastSeq).toBe(childSeq);
  });
});
