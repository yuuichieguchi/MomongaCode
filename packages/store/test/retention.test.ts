import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { RETENTION_TABLES } from '@momonga/store';
import type { RetentionPurge, Run, RuntimeStore } from '@momonga/store';
import { NEVER_CANCELLED } from '@momonga/testkit';
import { cancelToEnd, enqueue, harness, mustClaim, mustRun, newSession, rawDb } from './helpers.ts';

const DAY_MS = 86_400_000;
const PERIOD_DAYS = 30;
const PERIOD_MS = PERIOD_DAYS * DAY_MS;

type Purged = { runIds: string[]; cutoffMs: number };

const recordingPurge = (calls: Purged[]): RetentionPurge => async (runIds, cutoffMs) => {
  calls.push({ runIds: [...runIds].sort(), cutoffMs });
};

const endedSession = async (store: RuntimeStore, cwd: string, input = 'task'): Promise<{ sessionId: string; run: Run }> => {
  const session = newSession(store, cwd);
  const run = await enqueue(store, session.id, input);
  return { sessionId: session.id, run: await cancelToEnd(store, run.id) };
};

const rowsReferring = (dbPath: string, sessionIds: readonly string[], runIds: readonly string[]): Record<string, number> => {
  const db = rawDb(dbPath);
  const counts: Record<string, number> = {};
  for (const entry of RETENTION_TABLES) {
    if (entry.rule === 'kept') continue;
    const ids = entry.refers === 'session' ? sessionIds : runIds;
    if (ids.length === 0) continue;
    const marks = ids.map(() => '?').join(', ');
    const row = db.prepare(`SELECT COUNT(*) AS n FROM "${entry.table}" WHERE "${entry.column}" IN (${marks})`).get(...ids) as { n: number };
    counts[`${entry.table}.${entry.column}`] = row.n;
  }
  return counts;
};

const blobFile = (dir: string, handle: string): string => path.join(dir, 'blobs', handle);

describe('retentionSweep', () => {
  it('deletes an expired terminal session from every table of the registry and leaves a newer session untouched', async () => {
    const { store, clock, dbPath, dir } = harness();
    const old = await endedSession(store, '/work/old');
    const { handle } = await store.blobs.put('only the old run holds this', { mediaType: 'text/plain', runId: old.run.id });
    clock.advance((PERIOD_DAYS + 1) * DAY_MS);
    const fresh = await endedSession(store, '/work/new');
    const calls: Purged[] = [];

    const report = await store.retention.sweep({ periodMs: PERIOD_MS, purges: [recordingPurge(calls)] }, NEVER_CANCELLED);

    expect(report).toMatchObject({ sessionsDeleted: 1, blobsCollected: 1, more: false });
    expect(Object.values(rowsReferring(dbPath, [old.sessionId], [old.run.id])).every((count) => count === 0)).toBe(true);
    expect(store.getSession(old.sessionId)).toBeUndefined();
    expect(store.getRun(old.run.id)).toBeUndefined();
    expect(existsSync(blobFile(dir, handle))).toBe(false);
    expect(store.getSession(fresh.sessionId)).toBeDefined();
    expect(mustRun(store, fresh.run.id).status).toBe('CANCELLED');
    expect(calls).toEqual([{ runIds: [old.run.id], cutoffMs: clock.now() - PERIOD_MS }]);
  });

  it('keeps an expired session that still has a run that has not ended', async () => {
    const { store, clock } = harness();
    const session = newSession(store, '/work/old');
    const queued = await enqueue(store, session.id);
    clock.advance((PERIOD_DAYS + 1) * DAY_MS);

    const report = await store.retention.sweep({ periodMs: PERIOD_MS, purges: [] }, NEVER_CANCELLED);

    expect(report.sessionsDeleted).toBe(0);
    expect(mustRun(store, queued.id).status).toBe('QUEUED');
  });

  it('keeps an old parent session while a child session that refers to it is newer, and deletes both once both are old', async () => {
    const { store, clock } = harness();
    const parentSession = newSession(store, '/work/a');
    await enqueue(store, parentSession.id);
    const claim = mustClaim(store, 'w-parent');
    const spawned = await store.createChildRun({ parentRunId: claim.runId, parentCallId: 'call-1', input: 'child task', pins: {}, model: 'fm' });
    if (spawned.kind !== 'created') throw new Error(`expected a child run, got ${spawned.kind}`);
    expect((await store.transition(claim, ['RUNNING'], 'COMPLETED')).kind).toBe('ok');
    await cancelToEnd(store, spawned.run.id);
    clock.advance((PERIOD_DAYS + 1) * DAY_MS);
    await cancelToEnd(store, (await enqueue(store, spawned.session.id, 'later')).id);

    expect((await store.retention.sweep({ periodMs: PERIOD_MS, purges: [] }, NEVER_CANCELLED)).sessionsDeleted).toBe(0);
    expect(store.getSession(parentSession.id)).toBeDefined();

    clock.advance((PERIOD_DAYS + 1) * DAY_MS);
    expect((await store.retention.sweep({ periodMs: PERIOD_MS, purges: [] }, NEVER_CANCELLED)).sessionsDeleted).toBe(2);
    expect(store.getSession(parentSession.id)).toBeUndefined();
    expect(store.getSession(spawned.session.id)).toBeUndefined();
  });

  it('still refuses a plain delete of an event', async () => {
    const { store, dbPath } = harness();
    await endedSession(store, '/work/a');
    expect(() => rawDb(dbPath).exec('DELETE FROM events')).toThrow(/append-only/);
  });

  it('finishes a sweep whose purge failed on the next sweep, with the same run ids', async () => {
    const { store, clock, dbPath } = harness();
    const old = await endedSession(store, '/work/old');
    clock.advance((PERIOD_DAYS + 1) * DAY_MS);
    const failing: RetentionPurge = async () => {
      throw new Error('the gateway did not answer');
    };

    await expect(store.retention.sweep({ periodMs: PERIOD_MS, purges: [failing] }, NEVER_CANCELLED)).rejects.toThrow('the gateway did not answer');
    expect(store.getSession(old.sessionId)).toBeUndefined();
    expect((rawDb(dbPath).prepare('SELECT COUNT(*) AS n FROM retention_sweeps').get() as { n: number }).n).toBe(1);

    const calls: Purged[] = [];
    await store.retention.sweep({ periodMs: PERIOD_MS, purges: [recordingPurge(calls)] }, NEVER_CANCELLED);
    expect(calls.map((call) => call.runIds)).toEqual([[old.run.id]]);
    expect((rawDb(dbPath).prepare('SELECT COUNT(*) AS n FROM retention_sweeps').get() as { n: number }).n).toBe(0);
  });

  it('keeps a blob another run still owns and collects it once no run owns it', async () => {
    const { store, clock, dir } = harness();
    const first = await endedSession(store, '/work/a');
    const { handle } = await store.blobs.put('shared content', { mediaType: 'text/plain', runId: first.run.id });
    clock.advance(20 * DAY_MS);
    const second = await endedSession(store, '/work/b');
    await store.blobs.put('shared content', { mediaType: 'text/plain', runId: second.run.id });
    clock.advance(11 * DAY_MS);

    expect((await store.retention.sweep({ periodMs: PERIOD_MS, purges: [] }, NEVER_CANCELLED)).blobsCollected).toBe(0);
    expect((await store.blobs.read(handle, { lineStart: 1, lineEnd: 1 }, { runId: second.run.id })).text).toBe('shared content');

    clock.advance(20 * DAY_MS);
    expect((await store.retention.sweep({ periodMs: PERIOD_MS, purges: [] }, NEVER_CANCELLED)).blobsCollected).toBe(1);
    expect(existsSync(blobFile(dir, handle))).toBe(false);
  });

  it('never leaves a blob row of a live run without its file when the same content is put while the sweep runs', async () => {
    const { store, clock } = harness();
    const old = await endedSession(store, '/work/old');
    await store.blobs.put('content put again', { mediaType: 'text/plain', runId: old.run.id });
    clock.advance((PERIOD_DAYS + 1) * DAY_MS);
    const live = newSession(store, '/work/live');
    const liveRun = await enqueue(store, live.id);
    const putDuringSweep: RetentionPurge = async () => {
      await store.blobs.put('content put again', { mediaType: 'text/plain', runId: liveRun.id });
    };

    await store.retention.sweep({ periodMs: PERIOD_MS, purges: [putDuringSweep] }, NEVER_CANCELLED);

    const handle = store.blobs.handleFor('content put again');
    expect((await store.blobs.read(handle, { lineStart: 1, lineEnd: 1 }, { runId: liveRun.id })).text).toBe('content put again');
  });

  it('writes the file again when the same content is put after the sweep collected it', async () => {
    const { store, clock } = harness();
    const old = await endedSession(store, '/work/old');
    await store.blobs.put('collected then put', { mediaType: 'text/plain', runId: old.run.id });
    clock.advance((PERIOD_DAYS + 1) * DAY_MS);
    const live = newSession(store, '/work/live');
    const liveRun = await enqueue(store, live.id);

    expect((await store.retention.sweep({ periodMs: PERIOD_MS, purges: [] }, NEVER_CANCELLED)).blobsCollected).toBe(1);
    const { handle } = await store.blobs.put('collected then put', { mediaType: 'text/plain', runId: liveRun.id });

    expect((await store.blobs.read(handle, { lineStart: 1, lineEnd: 1 }, { runId: liveRun.id })).text).toBe('collected then put');
  });
});
