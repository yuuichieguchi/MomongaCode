import { describe, expect, it } from 'vitest';
import { enqueue, harness, mustClaim, mustRun, newSession, rawDb } from '../helpers.ts';
import { recordNewerMigration } from './fixtures.ts';

const writeUnknown = (dbPath: string, table: string, column: string, value: string, id: string): void => {
  const db = rawDb(dbPath);
  db.exec('PRAGMA ignore_check_constraints = ON');
  db.prepare(`UPDATE ${table} SET ${column} = ? WHERE id = ?`).run(value, id);
  db.close();
};

const newerStore = () => {
  const env = harness();
  const db = rawDb(env.dbPath);
  recordNewerMigration(db);
  db.close();
  return env;
};

describe('claim selects only runs whose acted-on values this build knows (11.4)', () => {
  it.each([
    ['sessions', 'permission_mode', 'supervised'],
    ['runs', 'history_mode', 'branch'],
    ['runs', 'origin', 'vouched'],
  ] as const)('leaves a queued run alone while %s.%s holds an unknown value', async (table, column, value) => {
    const { store, dbPath } = newerStore();
    const session = newSession(store);
    const run = await enqueue(store, session.id);
    writeUnknown(dbPath, table, column, value, table === 'sessions' ? session.id : run.id);

    expect(store.claim('w-old')).toBeNull();
    expect(mustRun(store, run.id).status).toBe('QUEUED');
    expect(mustRun(store, run.id).leaseOwner).toBeNull();
  });

  it('claims the same run once the value is one this build knows', async () => {
    const { store, dbPath } = newerStore();
    const session = newSession(store);
    const run = await enqueue(store, session.id);
    writeUnknown(dbPath, 'sessions', 'permission_mode', 'supervised', session.id);
    expect(store.claim('w-old')).toBeNull();
    writeUnknown(dbPath, 'sessions', 'permission_mode', 'manual', session.id);
    expect(store.claim('w-old')?.runId).toBe(run.id);
  });
});

describe('a held run whose status becomes unknown is yielded untouched (11.4)', () => {
  it('releases the lease, keeps the unknown status and appends nothing', async () => {
    const { store, dbPath } = newerStore();
    const run = await enqueue(store, newSession(store).id);
    const claim = mustClaim(store, 'w-old');
    const before = mustRun(store, run.id).lastSeq;
    writeUnknown(dbPath, 'runs', 'status', 'PAUSED', run.id);

    expect((await store.releaseLease(claim, { availableAt: 0, refundAttempt: true })).kind).toBe('ok');
    const after = mustRun(store, run.id);
    expect(after.status).toBe('unknown');
    expect(after.leaseOwner).toBeNull();
    expect(after.lastSeq).toBe(before);
    expect(store.claim('w-old')).toBeNull();
  });
});
