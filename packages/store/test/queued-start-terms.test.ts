import { describe, expect, it } from 'vitest';
import { START_MS, enqueue, harness, mustClaim, newSession, rawDb } from './helpers.ts';

const QUEUED_TERMS = { timeoutMs: 120_000, limits: { maxSteps: 3 }, pins: { model: 'queued-model' } };

const sessionWithQueued = async () => {
  const env = harness();
  const session = newSession(env.store);
  const first = await enqueue(env.store, session.id, 'first');
  const claim = mustClaim(env.store, 'w1');
  const added = await env.store.inbox.add(session.id, { delivery: 'queue', text: 'the next task', run: QUEUED_TERMS });
  if (added.kind !== 'added') throw new Error(`expected a waiting message, got ${added.kind}`);
  return { ...env, session, first, claim, row: added.row };
};

describe('a queued message starts its run with the terms it was queued with', () => {
  it('gives the started run the limits, the deadline and the pins of the request that queued it, not those of the run that ended', async () => {
    const { store, first, claim } = await sessionWithQueued();
    expect(first.limits).not.toEqual(QUEUED_TERMS.limits);

    expect((await store.transition(claim, ['RUNNING'], 'COMPLETED')).kind).toBe('ok');

    const next = store.inbox.successorOf(first.id);
    expect(next?.limits).toEqual(QUEUED_TERMS.limits);
    expect(next === undefined ? undefined : next.deadlineAt - next.createdAt).toBe(QUEUED_TERMS.timeoutMs);
    expect(next?.pins).toMatchObject(QUEUED_TERMS.pins);
  });

  it('gives the started run the origin its folder had when the message was queued', async () => {
    const { store, dbPath, first, claim, session } = await sessionWithQueued();
    const db = rawDb(dbPath);
    db.prepare("UPDATE runs SET origin = 'trusted' WHERE id = ?").run(first.id);
    db.close();

    expect((await store.transition(claim, ['RUNNING'], 'COMPLETED')).kind).toBe('ok');

    expect(store.inbox.successorOf(first.id)?.origin).toBe('untrusted');
    expect(store.getSession(session.id)?.cwd).toBe('/work/a');
  });

  it('starts at once with its own terms when no run is working', async () => {
    const { store } = harness();
    const session = newSession(store);

    const added = await store.inbox.add(session.id, { delivery: 'queue', text: 'start now', run: QUEUED_TERMS });

    expect(added.kind).toBe('added');
    const [started] = store.listRuns(session.id);
    expect(started?.limits).toEqual(QUEUED_TERMS.limits);
    expect(started === undefined ? undefined : started.deadlineAt - START_MS).toBe(QUEUED_TERMS.timeoutMs);
  });

  it('starts no run from a message queued before its terms were recorded, and keeps it waiting where a person can see and withdraw it', async () => {
    const { store, dbPath, first, claim, session, row } = await sessionWithQueued();
    const db = rawDb(dbPath);
    db.prepare('UPDATE run_inbox SET run_terms_json = NULL, origin = NULL WHERE id = ?').run(row.id);
    db.close();

    expect((await store.transition(claim, ['RUNNING'], 'COMPLETED')).kind).toBe('ok');

    expect(store.inbox.successorOf(first.id)).toBeUndefined();
    expect(store.inbox.list(session.id).map((pending) => pending.id)).toEqual([row.id]);
    expect(store.inbox.withdraw(row.id).kind).toBe('withdrawn');
  });
});
