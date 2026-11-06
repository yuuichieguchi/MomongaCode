import { describe, expect, it } from 'vitest';
import { DEADLINE_MS, LEASE_MS, START_MS, enqueue, harness, newSession, rawDb } from '../helpers.ts';
import { awaitingApproval } from '../approval-fixture.ts';
import { recordNewerMigration } from './fixtures.ts';

const rethrow = (error: unknown): never => {
  throw error;
};

const setColumn = (dbPath: string, table: string, column: string, value: string, id: string): void => {
  const db = rawDb(dbPath);
  db.exec('PRAGMA ignore_check_constraints = ON');
  db.exec('DROP TRIGGER IF EXISTS runs_cancelling_has_cancel_origin_update');
  db.prepare(`UPDATE ${table} SET ${column} = ? WHERE id = ?`).run(value, id);
};

const withUnknownValues = (newer: boolean) => {
  const env = harness();
  const { runId, approvals } = awaitingApproval(env.store, [{ callId: 'c1' }], 'waiting');
  const approval = approvals[0];
  if (approval === undefined) throw new Error('no approval');
  const memory = env.store.memories.save({ origin: 'trusted', scope: 'project', project: '/work/a', text: 'tests live in test/', runId, step: 1, callId: 'c1' }).memory;
  const queued = enqueue(env.store, newSession(env.store).id, 'later');
  const db = rawDb(env.dbPath);
  if (newer) recordNewerMigration(db);
  setColumn(env.dbPath, 'runs', 'status', 'PAUSED', runId);
  setColumn(env.dbPath, 'runs', 'status', 'PARKED', queued.id);
  setColumn(env.dbPath, 'approvals', 'status', 'deferred', approval.id);
  setColumn(env.dbPath, 'memories', 'state', 'frozen', memory.id);
  return { ...env, runId, queuedId: queued.id, approvalId: approval.id, memoryId: memory.id };
};

describe('a value of a closed set this build does not know (H7, 11.4 rule 3)', () => {
  it('decodes as unknown when the database is newer than the build', () => {
    const { store, runId, approvalId, memoryId } = withUnknownValues(true);
    expect(store.getRun(runId)?.status).toBe('unknown');
    expect(store.approvals.get(approvalId)?.status).toBe('unknown');
    expect(store.memories.get(memoryId)?.state).toBe('unknown');
  });

  it('still throws when the database is not newer, as corruption', () => {
    const { store, runId, approvalId, memoryId } = withUnknownValues(false);
    expect(() => store.getRun(runId)).toThrow(/column status has unexpected value "PAUSED"/);
    expect(() => store.approvals.get(approvalId)).toThrow(/column status has unexpected value "deferred"/);
    expect(() => store.memories.get(memoryId)).toThrow(/column state has unexpected value "frozen"/);
  });

  it('is never acted on by claim, the sweepers, dead-lettering or approval resolution', async () => {
    const { store, clock, runId, queuedId, approvalId } = withUnknownValues(true);
    clock.set(DEADLINE_MS + LEASE_MS + 1);
    expect(store.claim('w-new')).toBeNull();
    expect(await store.expireApprovals(START_MS + 10 * DEADLINE_MS, rethrow)).toEqual([]);
    expect(await store.finishCancelled(rethrow)).toEqual([]);
    expect(await store.deadLetterExhausted(rethrow)).toEqual([]);
    expect(store.requestCancel(queuedId).kind).not.toBe('ok');
    expect((await store.resolveApproval(approvalId, 'allow_once')).kind).not.toBe('ok');
    expect(store.getRun(runId)?.status).toBe('unknown');
    expect(store.getRun(queuedId)?.status).toBe('unknown');
    expect(store.approvals.get(approvalId)?.status).toBe('unknown');
  });
});
