import { describe, expect, it } from 'vitest';
import type { RunEventPayload } from '@momonga/protocol';
import { enqueue, harness, mustClaim, newSession, rawDb } from '../helpers.ts';
import { appendForeignRunEvent, appendForeignSessionEvent, recordNewerMigration } from './fixtures.ts';

const notices = (count: number, prefix: string): RunEventPayload[] => Array.from({ length: count }, (_, index) => ({ type: 'notice', level: 'info', message: `${prefix}${index + 1}` }));

describe('a page of reads that holds an opaque event (H7, 11.4)', () => {
  it('still returns limit known events while more exist, so a short page still means the end', async () => {
    const { store, dbPath } = harness();
    const session = newSession(store);
    const run = await enqueue(store, session.id, 'task');
    const claim = mustClaim(store, 'w1');
    const db = rawDb(dbPath);
    recordNewerMigration(db);
    store.append(claim, notices(2, 'before'));
    const opaqueSeq = appendForeignRunEvent(db, run.id, 'made.up', {});
    appendForeignSessionEvent(db, session.id, 'session.made.up', {});
    store.append(claim, notices(6, 'after'));
    const all = store.readRunEvents(run.id, 0, 10_000);
    expect(all.map((event) => event.seq)).not.toContain(opaqueSeq);
    const firstPage = store.readRunEvents(run.id, 0, opaqueSeq + 1);
    expect(firstPage).toHaveLength(opaqueSeq + 1);
    expect(firstPage.map((event) => event.seq)).toEqual(all.slice(0, opaqueSeq + 1).map((event) => event.seq));
    const [first] = store.readRunEvents(run.id, opaqueSeq - 1, 1);
    expect(first?.seq).toBe(opaqueSeq + 1);
    const sessionAll = store.readSessionEvents(session.id, 0, 10_000);
    const sessionPage = store.readSessionEvents(session.id, 0, sessionAll.length - 1);
    expect(sessionPage.map((event) => event.id)).toEqual(sessionAll.slice(0, -1).map((event) => event.id));
  });
});
