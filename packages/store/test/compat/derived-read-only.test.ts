import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { createDerivedSnapshot } from '../../src/derived-repair.ts';
import { enqueue, harness, mustClaim, newSession, rawDb, registerCleanup } from '../helpers.ts';
import { appendForeignRunEvent } from './fixtures.ts';

const PINNED = 'p'.repeat(64);

const journalConnection = (dbPath: string): DatabaseSync => {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA query_only = ON');
  registerCleanup(() => {
    if (db.isOpen) db.close();
  });
  return db;
};

describe('the read-only journal connection derives the part past the watermark in memory (H7, 11.5 correction rule 1)', () => {
  it('returns each row its pinned_digest and call_id derived from its payload, and writes nothing', () => {
    const { store, dbPath } = harness();
    const session = newSession(store);
    const run = enqueue(store, session.id, 'task');
    mustClaim(store, 'w-old');
    const writer = rawDb(dbPath);
    const requested = appendForeignRunEvent(writer, run.id, 'model.requested', { step: 1, attempt: 1, digest: 'd1', pinnedDigest: PINNED, body: { model: 'fm', input: [] } });
    appendForeignRunEvent(writer, run.id, 'tool.call', { callId: 'c1', providerCallId: 'c1', name: 'Write', kind: 'edit', title: 'c1', rawInput: { file_path: '/work/a/x' } });
    const db = journalConnection(dbPath);
    const changesBefore = Number(db.prepare('SELECT total_changes() AS n').get()?.['n']);
    const read = createDerivedSnapshot(db).read((view) => ({ pinned: view.pinnedDigestsOf(run.id), owners: view.callOwnersOf(session.id, 'c1') }));
    expect(read.pinned).toEqual([{ seq: requested, pinnedDigest: PINNED }]);
    expect(read.owners).toEqual([run.id]);
    expect(Number(db.prepare('SELECT total_changes() AS n').get()?.['n'])).toBe(changesBefore);
    expect(writer.prepare('SELECT pinned_digest, call_id FROM events WHERE run_id = ? AND seq >= ? ORDER BY seq').all(run.id, requested)).toEqual([
      { pinned_digest: null, call_id: null },
      { pinned_digest: null, call_id: null },
    ]);
  });
});
