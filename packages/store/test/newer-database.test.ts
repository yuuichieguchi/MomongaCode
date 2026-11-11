import { describe, expect, it } from 'vitest';
import type { HistoryVisibility } from '@momonga/store';
import { enqueue, harness, mustClaim, newSession, rawDb } from './helpers.ts';
import { appendForeignRunEvent, recordNewerMigration } from './compat/fixtures.ts';
import { redactor } from './search-fixture.ts';

const OWN: HistoryVisibility = { trusted: true, project: '/work/a' };

const TERMS = { timeoutMs: 60_000, limits: {}, pins: {} };

const writeForeign = (dbPath: string, column: 'delivery' | 'state', id: string, newer: boolean): void => {
  const db = rawDb(dbPath);
  if (newer) recordNewerMigration(db);
  db.exec('PRAGMA ignore_check_constraints = ON');
  db.prepare(`UPDATE run_inbox SET ${column} = 'from-a-newer-build'${column === 'state' ? ', settled_at = 1' : ''} WHERE id = ?`).run(id);
  db.close();
};

const sessionWithWaitingMessage = async () => {
  const env = harness();
  const session = newSession(env.store);
  const run = await enqueue(env.store, session.id, 'task');
  const claim = mustClaim(env.store, 'w1');
  const added = await env.store.inbox.add(session.id, { delivery: 'queue', text: 'next task', run: TERMS });
  if (added.kind !== 'added') throw new Error(`expected a waiting message, got ${added.kind}`);
  return { ...env, session, run, claim, row: added.row };
};

describe('a database written by a newer build is read with tolerance', () => {
  it('reads a recorded range that holds an event type this build does not know', async () => {
    const env = harness();
    const session = newSession(env.store);
    const run = await enqueue(env.store, session.id, 'task');
    const db = rawDb(env.dbPath);
    recordNewerMigration(db);
    const foreignSeq = appendForeignRunEvent(db, run.id, 'made.up', { detail: 'from a newer build' });
    db.close();

    const page = await env.store.search.readRange(OWN, { runId: run.id, limit: 100, redactor });

    if (page.kind !== 'ok') throw new Error(`expected a page, got ${page.kind}`);
    expect(page.events.map((event) => event.seq)).not.toContain(foreignSeq);
    expect(page.events.length).toBeGreaterThan(0);
  });

  it('still refuses that event type in a recorded range when the database is not newer', async () => {
    const env = harness();
    const session = newSession(env.store);
    const run = await enqueue(env.store, session.id, 'task');
    const db = rawDb(env.dbPath);
    appendForeignRunEvent(db, run.id, 'made.up', { detail: 'corrupt' });
    db.close();

    await expect(env.store.search.readRange(OWN, { runId: run.id, limit: 100, redactor })).rejects.toThrow(/unknown event type "made.up"/);
  });

  it('leaves a waiting message whose state this build does not know as it is, and ends the run', async () => {
    const { store, dbPath, claim, run, row } = await sessionWithWaitingMessage();
    writeForeign(dbPath, 'state', row.id, true);

    expect(() => store.inbox.withdraw(row.id)).toThrow(/a state this build does not know/);
    expect((await store.transition(claim, ['RUNNING'], 'COMPLETED', {})).kind).toBe('ok');
    expect(store.inbox.successorOf(run.id)).toBeUndefined();
  });

  it('keeps a waiting message whose delivery this build does not know, starts no run from it, and ends the run', async () => {
    const { store, dbPath, session, claim, run, row } = await sessionWithWaitingMessage();
    writeForeign(dbPath, 'delivery', row.id, true);

    expect(store.inbox.list(session.id)).toMatchObject([{ id: row.id, delivery: 'unknown', state: 'pending' }]);
    expect((await store.transition(claim, ['RUNNING'], 'COMPLETED', {})).kind).toBe('ok');
    expect(store.inbox.successorOf(run.id)).toBeUndefined();
    expect(store.inbox.list(session.id)).toMatchObject([{ id: row.id, delivery: 'unknown', state: 'pending' }]);
  });

  it('still refuses a foreign inbox value when the database is not newer', async () => {
    const { store, dbPath, session, row } = await sessionWithWaitingMessage();
    writeForeign(dbPath, 'delivery', row.id, false);

    expect(() => store.inbox.list(session.id)).toThrow(/column delivery has unexpected value "from-a-newer-build"/);
  });
});
