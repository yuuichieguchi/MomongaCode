import { describe, expect, it } from 'vitest';
import type { ElicitationRequestView } from '@momonga/protocol';
import type { Claim, ContributionPreparer, Run, RuntimeStore } from '@momonga/store';
import { EXPIRES_MS, awaitingApproval } from './approval-fixture.ts';
import { LEASE_MS, callEvent, cancel, enqueue, harness, mustClaim, mustRun, newSession, noJournalFacts, rawDb } from './helpers.ts';
import type { Harness } from './helpers.ts';
import { contributionOf } from './preparer-fixture.ts';

type Measurement = { runId: string; underWriteLock: boolean };

const REQUESTS: ElicitationRequestView[] = [
  { key: 'who', mode: 'form', message: 'Who are you?', requestedSchema: { type: 'object', properties: { name: { type: 'string' } } } },
];

const ignoreSweepErrors = (): void => undefined;

const measuring = (options: { maxAttempts?: number } = {}): { h: Harness; measurements: Measurement[] } => {
  const measurements: Measurement[] = [];
  let probe: (() => boolean) | undefined;
  let bound: RuntimeStore | undefined;
  const preparer: ContributionPreparer = {
    ...noJournalFacts,
    measure: async ({ runId }) => {
      if (probe === undefined || bound === undefined) throw new Error('the write-lock probe is not ready');
      measurements.push({ runId, underWriteLock: probe() });
      return { lastSeq: bound.getRun(runId)?.lastSeq ?? -1, contribution: contributionOf('m1') };
    },
  };
  const h = harness({ ...options, preparer });
  bound = h.store;
  const db = rawDb(h.dbPath);
  db.exec('PRAGMA busy_timeout = 0');
  probe = () => {
    try {
      db.exec('BEGIN IMMEDIATE');
    } catch (error) {
      if (error instanceof Error && /locked|busy/i.test(error.message)) return true;
      throw error;
    }
    db.exec('ROLLBACK');
    return false;
  };
  return { h, measurements };
};

const outsideTheTransaction = (measurements: readonly Measurement[], runIds: readonly string[]): void => {
  expect(measurements.map((measurement) => measurement.runId).sort()).toEqual([...runIds].sort());
  expect(measurements.filter((measurement) => measurement.underWriteLock)).toEqual([]);
};

const contributionsOf = (store: RuntimeStore, runId: string): number => store.readRunEvents(runId, 0, 1000).filter((event) => event.type === 'context.contribution').length;

const spawn = async (store: RuntimeStore, parentRunId: string, callId: string): Promise<Run> => {
  const created = await store.createChildRun({ parentRunId, parentCallId: callId, input: 'Child', pins: {}, model: 'fm' });
  if (created.kind !== 'created') throw new Error(`child run was not created: ${created.kind}`);
  return created.run;
};

describe('every terminal operation measures one run, outside the write transaction', () => {
  it('the dead-letter sweep measures each exhausted run in its own operation, outside its transaction', async () => {
    const { h, measurements } = measuring({ maxAttempts: 1 });
    const first = await enqueue(h.store, newSession(h.store).id);
    const second = await enqueue(h.store, newSession(h.store).id);
    mustClaim(h.store, 'w1');
    mustClaim(h.store, 'w2');
    h.clock.advance(LEASE_MS);

    expect(h.store.claim('w3')).toBeNull();
    expect(measurements).toEqual([]);
    expect((await h.store.deadLetterExhausted(ignoreSweepErrors)).sort()).toEqual([first.id, second.id].sort());

    expect(mustRun(h.store, first.id)).toMatchObject({ status: 'FAILED', deadLetter: true });
    expect(mustRun(h.store, second.id)).toMatchObject({ status: 'FAILED', deadLetter: true });
    outsideTheTransaction(measurements, [first.id, second.id]);
    expect(contributionsOf(h.store, first.id)).toBe(1);
    expect(contributionsOf(h.store, second.id)).toBe(1);
  });

  it('dead-lettering a parent moves its queued child to CANCELLING without measuring the child; the child is finished by its own operation', async () => {
    const { h, measurements } = measuring({ maxAttempts: 1 });
    const parent = await enqueue(h.store, newSession(h.store).id);
    mustClaim(h.store, 'w1');
    const child = await spawn(h.store, parent.id, 'call_child');
    h.clock.advance(LEASE_MS);

    expect(await h.store.deadLetterExhausted(ignoreSweepErrors)).toEqual([parent.id]);

    expect(mustRun(h.store, child.id)).toMatchObject({ status: 'CANCELLING', cancelOrigin: 'QUEUED' });
    outsideTheTransaction(measurements, [parent.id]);
    expect(await h.store.finishCancelled(ignoreSweepErrors)).toEqual([child.id]);
    outsideTheTransaction(measurements, [parent.id, child.id]);
  });

  it('an answer to an approval long after the request requeues the run and measures nothing', async () => {
    const { h, measurements } = measuring();
    const { runId, approvals } = await awaitingApproval(h.store, [{ callId: 'call_1' }], 'waiting');
    h.clock.set(mustRun(h.store, runId).deadlineAt - 1);

    expect(await h.store.resolveApproval(approvals[0]?.id ?? '', 'allow_once')).toMatchObject({ kind: 'ok', run: { status: 'QUEUED' } });
    expect(measurements).toEqual([]);
  });

  it('a late answer to an expired elicitation stops the run through an awaited operation, outside the transaction', async () => {
    const { h, measurements } = measuring();
    const run = await enqueue(h.store, newSession(h.store).id);
    const claim: Claim = mustClaim(h.store, 'w1');
    expect(h.store.append(claim, [callEvent('call_1')]).kind).toBe('ok');
    const requested = await h.store.requestElicitation(claim, { callId: 'call_1', expiresAt: EXPIRES_MS, server: 'remote', requests: REQUESTS });
    if (requested.kind !== 'ok') throw new Error('expected an elicitation');
    expect((await h.store.release(claim, 'WAITING_HUMAN')).kind).toBe('ok');
    h.clock.set(EXPIRES_MS);

    const pending = h.store.resolveElicitation(requested.approval.id, {});

    expect(pending).toBeInstanceOf(Promise);
    expect(await pending).toEqual({ kind: 'approval_not_pending', status: 'expired' });
    expect(mustRun(h.store, run.id)).toMatchObject({ status: 'STOPPED', stopReason: 'approval_timeout' });
    outsideTheTransaction(measurements, [run.id]);
  });

  it('a cancel that reaches grandchildren through a running child moves every descendant to CANCELLING and measures none', async () => {
    const { h, measurements } = measuring();
    const parent = await enqueue(h.store, newSession(h.store).id);
    mustClaim(h.store, 'w-parent');
    const child = await spawn(h.store, parent.id, 'call_child');
    mustClaim(h.store, 'w-child');
    const grandchild = await spawn(h.store, child.id, 'call_grandchild');

    expect((await cancel(h.store, parent.id)).status).toBe('CANCELLING');

    expect(mustRun(h.store, child.id)).toMatchObject({ status: 'CANCELLING', cancelOrigin: 'RUNNING' });
    expect(mustRun(h.store, grandchild.id)).toMatchObject({ status: 'CANCELLING', cancelOrigin: 'QUEUED' });
    expect(measurements).toEqual([]);
  });

  it('a cancel that reaches a child waiting for a person and its queued child moves both to CANCELLING with their own origins and measures none', async () => {
    const { h, measurements } = measuring();
    const parent = await enqueue(h.store, newSession(h.store).id);
    mustClaim(h.store, 'w-parent');
    const child = await spawn(h.store, parent.id, 'call_child');
    const childClaim = mustClaim(h.store, 'w-child');
    const grandchild = await spawn(h.store, child.id, 'call_grandchild');
    expect(h.store.append(childClaim, [callEvent('call_w')]).kind).toBe('ok');
    const approval = await h.store.requestApproval(childClaim, {
      callId: 'call_w',
      options: [{ optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' }],
      event: { subjectDigest: 'a'.repeat(64), reason: 'edits require approval', shown: { title: 'approval', input: {} } },
    });
    expect(approval.kind).toBe('ok');
    expect((await h.store.release(childClaim, 'WAITING_HUMAN')).kind).toBe('ok');

    await cancel(h.store, parent.id);

    expect(mustRun(h.store, child.id)).toMatchObject({ status: 'CANCELLING', cancelOrigin: 'WAITING_HUMAN' });
    expect(mustRun(h.store, grandchild.id)).toMatchObject({ status: 'CANCELLING', cancelOrigin: 'QUEUED' });
    expect(h.store.approvals.listPending(child.id)).toEqual([]);
    expect(measurements).toEqual([]);
  });
});
