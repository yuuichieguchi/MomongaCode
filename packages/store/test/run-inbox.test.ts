import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { migrate } from '@momonga/foundation';
import type { Migration } from '@momonga/foundation';
import { INBOX_MAX_PENDING } from '@momonga/protocol';
import type { InboxDelivery } from '@momonga/protocol';
import type { InboxRow, Run, RuntimeStore } from '@momonga/store';
import { MIGRATIONS } from '../src/schema.ts';
import { START_MS, TIMEOUT_MS, cancelToEnd, dbPathOf, enqueue, harness, makeStoreDir, mustClaim, mustRun, newSession, openStoreAt, rawDb } from './helpers.ts';

const TERMS = { timeoutMs: TIMEOUT_MS, limits: { maxSteps: 10 }, pins: {} };

const inboxMigration = (): Migration => {
  const found = MIGRATIONS.filter((migration) => /CREATE TABLE run_inbox/.test(migration.sql));
  if (found.length !== 1 || found[0] === undefined) throw new Error(`expected one migration that creates run_inbox, found ${found.length}`);
  return found[0];
};

const add = async (store: RuntimeStore, sessionId: string, delivery: InboxDelivery, text: string): Promise<InboxRow> => {
  const result = await store.inbox.add(sessionId, { delivery, text, run: TERMS });
  if (result.kind !== 'added') throw new Error(`expected the message to be added, got ${result.kind}`);
  return result.row;
};

const texts = (rows: readonly Pick<InboxRow, 'delivery' | 'text'>[]): string[] => rows.map((row) => `${row.delivery}:${row.text}`);

const runsOf = (store: RuntimeStore, sessionId: string): Run[] => store.listRuns(sessionId);

const userMessages = (store: RuntimeStore, runId: string) =>
  store.readRunEvents(runId, 0, 1000).flatMap((event) => (event.type === 'user.message' ? [{ text: event.text, ...(event.source === undefined ? {} : { source: event.source }) }] : []));

const textsById = (store: RuntimeStore): Map<string, string> => {
  const db = rawDb(dbPathOf(store));
  try {
    return new Map(db.prepare('SELECT id, text FROM run_inbox').all().map((row) => [String(row['id']), String(row['text'])]));
  } finally {
    db.close();
  }
};

const inboxEvents = (store: RuntimeStore, sessionId: string): string[][] => {
  const stored = textsById(store);
  return store.readSessionEvents(sessionId, 0, 1000).flatMap((event) => (event.type === 'inbox.changed' ? [event.pending.map((row) => `${row.delivery}:${stored.get(row.id)}`)] : []));
};

const busySession = async (store: RuntimeStore) => {
  const session = newSession(store);
  const run = await enqueue(store, session.id, 'first');
  const claim = mustClaim(store, 'w1');
  return { session, run, claim };
};

describe('the run inbox migration', () => {
  it('is one step of its own after the step that names the asking mode, and rebuilds no table', () => {
    const migration = inboxMigration();
    const manual = MIGRATIONS.find((candidate) => /asking mode .*manual/.test(candidate.name));
    expect(migration.version).toBe((manual?.version ?? 0) + 1);
    expect(migration.rebuildsReferencedTable).toBeUndefined();
    expect(migration.sql).not.toMatch(/\bDROP\b|\bRENAME\b|ALTER TABLE/);
  });

  it('adds the table to a database of the previous version and keeps its sessions and runs', () => {
    const db = new DatabaseSync(path.join(makeStoreDir(), 'runtime.db'));
    try {
      db.exec('PRAGMA foreign_keys = ON');
      migrate(db, MIGRATIONS.filter((migration) => migration.version < inboxMigration().version));
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'run_inbox'").get()).toBeUndefined();
      db.prepare(
        `INSERT INTO sessions (id, cwd, env_json, permission_mode, model_alias, created_at, bypass_allowed, additional_directories_json, mcp_servers_json)
         VALUES ('old', '/work/old', '{}', 'manual', 'fm', ?, 0, '[]', '{}')`,
      ).run(START_MS);
      const before = db.prepare('SELECT * FROM sessions').all();
      migrate(db, MIGRATIONS.filter((migration) => migration.version <= inboxMigration().version));
      expect(db.prepare('SELECT * FROM sessions').all()).toEqual(before);
      const columns = db.prepare("SELECT name FROM pragma_table_info('run_inbox') ORDER BY cid").all().map((row) => String(row['name']));
      expect(columns).toEqual(['id', 'session_id', 'delivery', 'text', 'attachments', 'seq', 'state', 'created_at', 'settled_at']);
      const insert = db.prepare("INSERT INTO run_inbox (id, session_id, delivery, text, attachments, seq, state, created_at, settled_at) VALUES (?, 'old', ?, 'x', '[]', ?, ?, 1, ?)");
      insert.run('a', 'queue', 1, 'pending', null);
      expect(() => insert.run('b', 'interrupt', 2, 'pending', null)).toThrow();
      expect(() => insert.run('c', 'queue', 3, 'lost', null)).toThrow();
      expect(() => insert.run('d', 'queue', 1, 'pending', null)).toThrow();
      expect(() => insert.run('e', 'queue', 4, 'pending', 5)).toThrow();
      expect(() => insert.run('f', 'queue', 5, 'delivered', null)).toThrow();
      db.prepare("DELETE FROM sessions WHERE id = 'old'").run();
      expect(db.prepare('SELECT COUNT(*) AS n FROM run_inbox').get()).toEqual({ n: 0 });
    } finally {
      db.close();
    }
  });
});

describe('adding, listing and taking back (design 5.3)', () => {
  it('stores a row with a per-session seq and lists the pending rows in seq order', async () => {
    const h = harness();
    const { session } = await busySession(h.store);
    const other = newSession(h.store, '/work/b');
    await enqueue(h.store, other.id, 'other first');
    const first = await add(h.store, session.id, 'queue', 'one');
    const second = await add(h.store, session.id, 'steer', 'two');
    const foreign = await add(h.store, other.id, 'queue', 'elsewhere');
    expect(first).toEqual({ id: expect.any(String), sessionId: session.id, delivery: 'queue', text: 'one', seq: 1, state: 'pending', createdAt: h.clock.now(), settledAt: null, queued: { terms: TERMS, origin: 'untrusted' } });
    expect(second.seq).toBe(2);
    expect(foreign.seq).toBe(1);
    expect(texts(h.store.inbox.list(session.id))).toEqual(['queue:one', 'steer:two']);
    expect(texts(h.store.inbox.list(other.id))).toEqual(['queue:elsewhere']);
    expect(inboxEvents(h.store, session.id)).toEqual([['queue:one'], ['queue:one', 'steer:two']]);
  });

  it('keeps the images of a row in the shape of a prompt', async () => {
    const h = harness();
    const { session } = await busySession(h.store);
    const images = [{ mediaType: 'image/png' as const, data: 'AAAA' }];
    const result = await h.store.inbox.add(session.id, { delivery: 'queue', text: 'look', images, run: TERMS });
    expect(result).toMatchObject({ kind: 'added', row: { images } });
    expect(h.store.inbox.list(session.id)[0]?.images).toEqual(images);
  });

  it('answers not_found for an unknown session and for an unknown row', async () => {
    const h = harness();
    expect(await h.store.inbox.add('nope', { delivery: 'queue', text: 'x', run: TERMS })).toEqual({ kind: 'not_found' });
    expect(h.store.inbox.withdraw('nope')).toEqual({ kind: 'not_found' });
  });

  it(`refuses the message after ${INBOX_MAX_PENDING} pending ones, and takes one again after a withdrawal`, async () => {
    const h = harness();
    const { session } = await busySession(h.store);
    const rows: InboxRow[] = [];
    for (let index = 0; index < INBOX_MAX_PENDING; index += 1) rows.push(await add(h.store, session.id, index % 2 === 0 ? 'queue' : 'steer', `m${index}`));
    expect(await h.store.inbox.add(session.id, { delivery: 'queue', text: 'too many', run: TERMS })).toEqual({ kind: 'full' });
    expect(h.store.inbox.list(session.id)).toHaveLength(INBOX_MAX_PENDING);
    h.store.inbox.withdraw(rows[0]?.id ?? '');
    expect((await add(h.store, session.id, 'queue', 'fits')).seq).toBe(INBOX_MAX_PENDING + 1);
  });

  it('withdraws a pending row once, and answers already_delivered for a delivered one', async () => {
    const h = harness();
    const { session, claim } = await busySession(h.store);
    const queued = await add(h.store, session.id, 'queue', 'one');
    const steered = await add(h.store, session.id, 'steer', 'two');
    h.clock.advance(5);
    const taken = h.store.inbox.withdraw(queued.id);
    expect(taken).toMatchObject({ kind: 'withdrawn', row: { id: queued.id, state: 'withdrawn', settledAt: h.clock.now() } });
    expect(taken.kind === 'withdrawn' ? texts(taken.pending) : []).toEqual(['steer:two']);
    expect(h.store.inbox.withdraw(queued.id)).toMatchObject({ kind: 'withdrawn', row: { state: 'withdrawn' } });
    expect(h.store.inbox.deliverSteering(claim)).toMatchObject({ kind: 'ok' });
    expect(h.store.inbox.withdraw(steered.id)).toMatchObject({ kind: 'already_delivered', row: { id: steered.id, state: 'delivered' }, pending: [] });
    expect(inboxEvents(h.store, session.id).at(-1)).toEqual([]);
  });
});

describe('steering at the step boundary', () => {
  it('carries the files a message named with @ into the user message it becomes, steered or queued', async () => {
    const h = harness();
    const { session, run, claim } = await busySession(h.store);
    const file = { type: 'attached_file' as const, path: 'src/app.tsx', content: '     1\tfirst', truncated: false as const };
    const attachments = [file, { type: 'attachment_note' as const, path: '.env', text: 'The user referenced .env, which cannot be attached.', shown: '.env: not attached' }];
    await h.store.inbox.add(session.id, { delivery: 'steer', text: 'see @src/app.tsx and @.env', attachments, run: TERMS });
    h.store.inbox.deliverSteering(claim);
    const steered = h.store.readRunEvents(run.id, 0, 1000).filter((event) => event.type === 'user.message').at(-1);
    expect(steered).toMatchObject({ text: 'see @src/app.tsx and @.env', source: 'steer', attachments });
    const other = newSession(h.store);
    const waiting = await enqueue(h.store, other.id, 'first');
    await h.store.inbox.add(other.id, { delivery: 'queue', text: 'then @src/app.tsx', attachments: [file], run: TERMS });
    await cancelToEnd(h.store, waiting.id);
    const queued = h.store.readRunEvents(h.store.inbox.successorOf(waiting.id)?.id ?? '', 0, 1000).find((event) => event.type === 'user.message');
    expect(queued).toMatchObject({ text: 'then @src/app.tsx', source: 'queue', attachments: [file] });
  });

  it('delivers every pending steer row in seq order as user messages marked steer, in the run, and leaves the queued rows', async () => {
    const h = harness();
    const { session, run, claim } = await busySession(h.store);
    await add(h.store, session.id, 'steer', 'also the tests');
    await add(h.store, session.id, 'queue', 'later');
    await add(h.store, session.id, 'steer', 'and the docs');
    h.clock.advance(7);
    const drained = h.store.inbox.deliverSteering(claim);
    expect(drained.kind === 'ok' ? texts(drained.delivered) : []).toEqual(['steer:also the tests', 'steer:and the docs']);
    expect(drained.kind === 'ok' ? drained.delivered.map((row) => [row.state, row.settledAt]) : []).toEqual([['delivered', h.clock.now()], ['delivered', h.clock.now()]]);
    expect(userMessages(h.store, run.id)).toEqual([{ text: 'first' }, { text: 'also the tests', source: 'steer' }, { text: 'and the docs', source: 'steer' }]);
    expect(mustRun(h.store, run.id).lastSeq).toBe(h.store.readRunEvents(run.id, 0, 1000).at(-1)?.seq);
    expect(texts(h.store.inbox.list(session.id))).toEqual(['queue:later']);
    expect(inboxEvents(h.store, session.id).at(-1)).toEqual(['queue:later']);
    expect(h.store.inbox.deliverSteering(claim)).toEqual({ kind: 'ok', delivered: [] });
    expect(userMessages(h.store, run.id)).toHaveLength(3);
  });

  it('delivers nothing under a lost lease and keeps the rows pending', async () => {
    const h = harness();
    const { session, run, claim } = await busySession(h.store);
    await add(h.store, session.id, 'steer', 'kept');
    expect(h.store.inbox.deliverSteering({ ...claim, leaseToken: claim.leaseToken + 1 })).toEqual({ kind: 'lease_lost' });
    expect(texts(h.store.inbox.list(session.id))).toEqual(['steer:kept']);
    expect(userMessages(h.store, run.id)).toEqual([{ text: 'first' }]);
  });
});

describe('the end of a run with messages waiting', () => {
  it.each([
    ['COMPLETED', {}],
    ['FAILED', { error: { code: 'x', message: 'y' } }],
    ['STOPPED', { stopReason: 'max_steps' }],
  ] as const)('starts the queued message with the lowest seq as the next run when the run ends %s, in the same transaction', async (to, patch) => {
    const h = harness();
    const { session, run, claim } = await busySession(h.store);
    await add(h.store, session.id, 'queue', 'second');
    await add(h.store, session.id, 'queue', 'third');
    h.clock.advance(11);
    expect((await h.store.transition(claim, ['RUNNING'], to, patch)).kind).toBe('ok');
    const [, next, ...rest] = runsOf(h.store, session.id);
    expect(rest).toEqual([]);
    expect(next).toMatchObject({ status: 'QUEUED', ordinal: 2, previousRunId: run.id, parentRunId: null, history: 'inherit', limits: { maxSteps: 10 }, deadlineAt: h.clock.now() + TIMEOUT_MS, pins: {} });
    expect(userMessages(h.store, next?.id ?? '')).toEqual([{ text: 'second', source: 'queue' }]);
    expect(texts(h.store.inbox.list(session.id))).toEqual(['queue:third']);
    expect(inboxEvents(h.store, session.id).at(-1)).toEqual(['queue:third']);
    expect(h.store.inbox.successorOf(run.id)?.id).toBe(next?.id);
    expect(h.store.inbox.successorOf(next?.id ?? '')).toBeUndefined();
  });

  it('turns the steer rows still pending into queued ones with their seq, so a steered message is never later than a queued one', async () => {
    const h = harness();
    const { session, claim } = await busySession(h.store);
    await add(h.store, session.id, 'queue', 'queued first');
    await add(h.store, session.id, 'steer', 'steered second');
    await add(h.store, session.id, 'queue', 'queued third');
    await h.store.transition(claim, ['RUNNING'], 'COMPLETED');
    expect(h.store.inbox.list(session.id).map((row) => [row.delivery, row.text, row.seq])).toEqual([['queue', 'steered second', 2], ['queue', 'queued third', 3]]);
    const order: string[] = [];
    for (let turn = 0; turn < 3; turn += 1) {
      const next = mustClaim(h.store, 'w1');
      order.push(userMessages(h.store, next.runId)[0]?.text ?? '');
      await h.store.transition(next, ['RUNNING'], 'COMPLETED');
    }
    expect(order).toEqual(['queued first', 'steered second', 'queued third']);
    expect(h.store.inbox.list(session.id)).toEqual([]);
    expect(runsOf(h.store, session.id)).toHaveLength(4);
  });

  it('starts the first waiting message when the run is cancelled', async () => {
    const h = harness();
    const session = newSession(h.store);
    const run = await enqueue(h.store, session.id, 'first');
    await add(h.store, session.id, 'steer', 'instead');
    await cancelToEnd(h.store, run.id);
    expect(mustRun(h.store, run.id).status).toBe('CANCELLED');
    const next = h.store.inbox.successorOf(run.id);
    expect(next?.status).toBe('QUEUED');
    expect(userMessages(h.store, next?.id ?? '')).toEqual([{ text: 'instead', source: 'queue' }]);
    expect(h.store.inbox.list(session.id)).toEqual([]);
  });

  it('starts nothing while another run of the session is still open, and nothing when no message waits', async () => {
    const h = harness();
    const { session, claim } = await busySession(h.store);
    const second = await enqueue(h.store, session.id, 'typed by another client');
    await add(h.store, session.id, 'queue', 'waits for both');
    await h.store.transition(claim, ['RUNNING'], 'COMPLETED');
    expect(runsOf(h.store, session.id)).toHaveLength(2);
    expect(texts(h.store.inbox.list(session.id))).toEqual(['queue:waits for both']);
    const other = mustClaim(h.store, 'w1');
    expect(other.runId).toBe(second.id);
    await h.store.transition(other, ['RUNNING'], 'COMPLETED');
    expect(runsOf(h.store, session.id)).toHaveLength(3);
    const last = mustClaim(h.store, 'w1');
    await h.store.transition(last, ['RUNNING'], 'COMPLETED');
    expect(runsOf(h.store, session.id)).toHaveLength(3);
  });

  it('starts a message at once when it is added while no run of the session is open', async () => {
    const h = harness();
    const session = newSession(h.store);
    const result = await h.store.inbox.add(session.id, { delivery: 'steer', text: 'nobody runs', run: TERMS });
    expect(result).toMatchObject({ kind: 'added', row: { state: 'delivered', delivery: 'queue' }, pending: [] });
    const [run] = runsOf(h.store, session.id);
    expect(run).toMatchObject({ status: 'QUEUED', limits: TERMS.limits, deadlineAt: h.clock.now() + TIMEOUT_MS });
    expect(userMessages(h.store, run?.id ?? '')).toEqual([{ text: 'nobody runs', source: 'queue' }]);
  });

  it('keeps the waiting rows across a restart of the store', async () => {
    const h = harness();
    const { session, run } = await busySession(h.store);
    await add(h.store, session.id, 'steer', 'steered');
    await add(h.store, session.id, 'queue', 'queued');
    h.store.close();
    const reopened = openStoreAt(h.dbPath, h.clock);
    expect(texts(reopened.inbox.list(session.id))).toEqual(['steer:steered', 'queue:queued']);
    h.clock.advance(2000);
    const claim = mustClaim(reopened, 'w2');
    expect(claim.runId).toBe(run.id);
    expect(reopened.inbox.deliverSteering(claim)).toMatchObject({ kind: 'ok', delivered: [{ text: 'steered' }] });
    await reopened.transition(claim, ['RUNNING'], 'COMPLETED');
    expect(userMessages(reopened, reopened.inbox.successorOf(run.id)?.id ?? '')).toEqual([{ text: 'queued', source: 'queue' }]);
    expect(rawDb(h.dbPath).prepare("SELECT COUNT(*) AS n FROM run_inbox WHERE state = 'pending'").get()).toEqual({ n: 0 });
  });
});
