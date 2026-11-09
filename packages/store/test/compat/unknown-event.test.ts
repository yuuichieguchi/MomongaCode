import { describe, expect, it } from 'vitest';
import { enqueue, harness, mustClaim, newSession, rawDb } from '../helpers.ts';
import { appendForeignRunEvent, appendForeignSessionEvent, recordNewerMigration } from './fixtures.ts';

const runWithForeignEvent = (newer: boolean) => {
  const env = harness();
  const session = newSession(env.store);
  const run = enqueue(env.store, session.id, 'task');
  const claim = mustClaim(env.store, 'w1');
  const db = rawDb(env.dbPath);
  if (newer) recordNewerMigration(db);
  const seq = appendForeignRunEvent(db, run.id, 'made.up', { detail: 'from a newer build' });
  const sessionEventId = appendForeignSessionEvent(db, session.id, 'session.made.up', { detail: 'from a newer build' });
  return { ...env, session, run, claim, seq, sessionEventId };
};

describe('an event type this build does not know (H7, 11.4)', () => {
  it('decodes as an opaque event on the stream reads when the database is newer than the build', () => {
    const { store, run, session, seq, sessionEventId } = runWithForeignEvent(true);
    const streamed = store.readRunEventStream(run.id, 0, 100);
    expect(streamed.at(-1)).toMatchObject({ opaque: true, type: 'made.up', runId: run.id, sessionId: session.id, seq, payload: { type: 'made.up', detail: 'from a newer build' } });
    const sessionStream = store.readSessionEventStream(session.id, 0, 100);
    expect(sessionStream.at(-1)).toMatchObject({ opaque: true, type: 'session.made.up', id: sessionEventId, runId: null, seq: null, payload: { detail: 'from a newer build' } });
  });

  it('leaves it out of the reads folds use, so it changes no state', () => {
    const { store, run, seq } = runWithForeignEvent(true);
    const events = store.readRunEvents(run.id, 0, 100);
    expect(events.map((event) => event.seq)).not.toContain(seq);
    expect(events.every((event) => event.type !== ('made.up' as string))).toBe(true);
    expect(store.readSessionEvents(run.sessionId, 0, 100).every((event) => event.type !== ('session.made.up' as string))).toBe(true);
  });

  it('still throws when the database is not newer than the build, so corruption is not hidden', () => {
    const { store, run, session } = runWithForeignEvent(false);
    expect(() => store.readRunEvents(run.id, 0, 100)).toThrow(/unknown event type "made.up"/);
    expect(() => store.readRunEventStream(run.id, 0, 100)).toThrow(/unknown event type "made.up"/);
    expect(() => store.readSessionEventStream(session.id, 0, 100)).toThrow(/made\.up/);
  });
});
