import { describe, expect, it } from 'vitest';
import type { Approval, Claim, RuntimeStore } from '@momonga/store';
import { BUSY_WAIT_LIMIT_MS, openDatabase } from '@momonga/foundation';
import { callEvent, dbPathOf, enqueue, harness, mustClaim, mustRun, newSession, payloadOf } from './helpers.ts';
import { DIGEST, OPTIONS, requestFor } from './approval-fixture.ts';
import type { RunEventPayload } from '@momonga/protocol';

const requestedBeforeShown = async (store: RuntimeStore, claim: Claim, callId: string): Promise<Approval> => {
  const id = `old-${callId}`;
  const db = openDatabase(dbPathOf(store), { busyTimeoutMs: BUSY_WAIT_LIMIT_MS });
  db.prepare(
    "INSERT INTO approvals (id, run_id, call_id, status, options_json, expires_at, created_at, subject_digest, kind, server, requests_json) VALUES (?, ?, ?, 'pending', ?, NULL, 1, ?, 'permission', NULL, NULL)",
  ).run(id, claim.runId, callId, JSON.stringify(OPTIONS), DIGEST);
  db.close();
  const event = { type: 'tool.permission.requested', approvalId: id, callId, options: OPTIONS, subjectDigest: DIGEST, reason: 'edits require approval' } as unknown as RunEventPayload;
  expect(store.append(claim, [event]).kind).toBe('ok');
  const approval = store.approvals.get(id);
  if (approval === undefined) throw new Error(`expected approval ${id}`);
  return approval;
};

const waitingOn = async (store: RuntimeStore, ask: (claim: Claim) => Promise<Approval[]>) => {
  const session = newSession(store);
  const run = await enqueue(store, session.id);
  const claim = mustClaim(store, 'worker-1');
  expect(store.append(claim, [callEvent('call_1'), callEvent('call_2')]).kind).toBe('ok');
  const approvals = await ask(claim);
  expect((await store.release(claim, 'WAITING_HUMAN')).kind).toBe('ok');
  return { runId: run.id, approvals };
};

describe('a pending approval recorded before the approval carried what it shows', () => {
  it('is settled as superseded and its run is queued, so the worker asks again with the shown content', async () => {
    const { store } = harness();
    const { runId, approvals } = await waitingOn(store, async (claim) => [await requestedBeforeShown(store, claim, 'call_1'), await requestedBeforeShown(store, claim, 'call_2')]);

    const errors: unknown[] = [];
    expect(await store.reaskUnshownApprovals((error) => errors.push(error))).toEqual([runId]);

    expect(errors).toEqual([]);
    expect(approvals.map((approval) => store.approvals.get(approval.id)?.status)).toEqual(['superseded', 'superseded']);
    expect(mustRun(store, runId).status).toBe('QUEUED');
    const tail = store.readRunEvents(runId, 0, 100).slice(-3).map(payloadOf);
    expect(tail.slice(0, 2)).toEqual(approvals.map((approval) => ({ type: 'tool.permission.cancelled', approvalId: approval.id, reason: 'superseded' })));
    expect(tail[2]).toMatchObject({ type: 'run.status', from: 'WAITING_HUMAN', to: 'QUEUED' });
  });

  it('is served as a view without shown content rather than as corrupt, and nothing is settled twice', async () => {
    const { store } = harness();
    const { approvals } = await waitingOn(store, async (claim) => [await requestedBeforeShown(store, claim, 'call_1')]);
    await store.reaskUnshownApprovals(() => undefined);
    const [old] = approvals;
    if (old === undefined) throw new Error('expected the old approval');
    const view = await store.approvalView(old.id);
    expect(view?.status).toBe('superseded');
    expect(view).not.toHaveProperty('shown');
    expect(await store.reaskUnshownApprovals(() => undefined)).toEqual([]);
  });

  it('leaves an approval that carries its shown content waiting', async () => {
    const { store } = harness();
    const { runId, approvals } = await waitingOn(store, async (claim) => [await requestFor(store, claim, 'call_1')]);
    expect(await store.reaskUnshownApprovals(() => undefined)).toEqual([]);
    expect(store.approvals.get(approvals[0]?.id ?? '')?.status).toBe('pending');
    expect(mustRun(store, runId).status).toBe('WAITING_HUMAN');
  });

  it('marks the request row at append: shown is null for a request without its shown content and 1 for one with it', async () => {
    const { store } = harness();
    const { approvals } = await waitingOn(store, async (claim) => [await requestedBeforeShown(store, claim, 'call_1'), await requestFor(store, claim, 'call_2')]);
    const db = openDatabase(dbPathOf(store), { busyTimeoutMs: BUSY_WAIT_LIMIT_MS });
    try {
      const rows = db.prepare("SELECT approval_id, shown FROM events WHERE type = 'tool.permission.requested' ORDER BY seq").all() as { approval_id: string; shown: number | null }[];
      expect(rows).toEqual([
        { approval_id: approvals[0]?.id, shown: null },
        { approval_id: approvals[1]?.id, shown: 1 },
      ]);
    } finally {
      db.close();
    }
  });
});
