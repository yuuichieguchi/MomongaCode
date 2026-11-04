import { describe, expect, it } from 'vitest';
import type { ElicitationRequestView } from '@momonga/protocol';
import type { Claim, ContributionPayload, Run, RuntimeStore } from '@momonga/store';
import { EXPIRES_MS, awaitingApproval } from './approval-fixture.ts';
import { LEASE_MS, callEvent, cancel, enqueue, harness, mustClaim, mustRun, newSession, rawDb } from './helpers.ts';
import type { Harness } from './helpers.ts';

type Measurement = { runId: string; underWriteLock: boolean };

const contribution: ContributionPayload = { type: 'context.contribution', items: [{ kind: 'memory', id: 'm1', contributed: true }] };

const REQUESTS: ElicitationRequestView[] = [
  { key: 'who', mode: 'form', message: 'Who are you?', requestedSchema: { type: 'object', properties: { name: { type: 'string' } } } },
];

const measuring = (options: { maxAttempts?: number } = {}): { h: Harness; measurements: Measurement[] } => {
  const measurements: Measurement[] = [];
  let probe: (() => boolean) | undefined;
  const h = harness({
    ...options,
    contribution: {
      eventTypes: ['user.message'],
      measure: ({ run }) => {
        if (probe === undefined) throw new Error('the write-lock probe is not ready');
        measurements.push({ runId: run.id, underWriteLock: probe() });
        return contribution;
      },
    },
  });
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

const spawn = (store: RuntimeStore, parentRunId: string, callId: string): Run => {
  const created = store.createChildRun({ parentRunId, parentCallId: callId, input: 'Child', pins: {}, modelAlias: 'fm' });
  if (created.kind !== 'created') throw new Error(`child run was not created: ${created.kind}`);
  return created.run;
};

describe('measuring ahead of the write transaction on every terminal path', () => {
  it('measures the runs that claim dead-letters, all of them, before its transaction', () => {
    const { h, measurements } = measuring({ maxAttempts: 1 });
    const first = enqueue(h.store, newSession(h.store).id);
    const second = enqueue(h.store, newSession(h.store).id);
    mustClaim(h.store, 'w1');
    mustClaim(h.store, 'w2');
    h.clock.advance(LEASE_MS);

    expect(h.store.claim('w3')).toBeNull();

    expect(mustRun(h.store, first.id)).toMatchObject({ status: 'FAILED', deadLetter: true });
    expect(mustRun(h.store, second.id)).toMatchObject({ status: 'FAILED', deadLetter: true });
    outsideTheTransaction(measurements, [first.id, second.id]);
    expect(contributionsOf(h.store, first.id)).toBe(1);
    expect(contributionsOf(h.store, second.id)).toBe(1);
  });

  it('measures the queued child of a run that claim dead-letters before the transaction', () => {
    const { h, measurements } = measuring({ maxAttempts: 1 });
    const parent = enqueue(h.store, newSession(h.store).id);
    mustClaim(h.store, 'w1');
    const child = spawn(h.store, parent.id, 'call_child');
    h.clock.advance(LEASE_MS);

    expect(h.store.claim('w2')).toBeNull();

    expect(mustRun(h.store, child.id).status).toBe('CANCELLED');
    outsideTheTransaction(measurements, [parent.id, child.id]);
  });

  it('measures a run whose approval expired when a person answers late, before the transaction', () => {
    const { h, measurements } = measuring();
    const { runId, approvals } = awaitingApproval(h.store, [{ callId: 'call_1' }], 'waiting');
    h.clock.set(EXPIRES_MS);

    expect(h.store.resolveApproval(approvals[0]?.id ?? '', 'allow_once')).toEqual({ kind: 'approval_not_pending', status: 'expired' });

    expect(mustRun(h.store, runId)).toMatchObject({ status: 'STOPPED', stopReason: 'approval_timeout' });
    outsideTheTransaction(measurements, [runId]);
    expect(contributionsOf(h.store, runId)).toBe(1);
  });

  it('measures a run whose elicitation expired when a person answers late, before the transaction', () => {
    const { h, measurements } = measuring();
    const run = enqueue(h.store, newSession(h.store).id);
    const claim: Claim = mustClaim(h.store, 'w1');
    expect(h.store.append(claim, [callEvent('call_1')]).kind).toBe('ok');
    const requested = h.store.requestElicitation(claim, { callId: 'call_1', expiresAt: EXPIRES_MS, server: 'remote', requests: REQUESTS });
    if (requested.kind !== 'ok') throw new Error('expected an elicitation');
    expect(h.store.release(claim, 'WAITING_HUMAN').kind).toBe('ok');
    h.clock.set(EXPIRES_MS);

    expect(h.store.resolveElicitation(requested.approval.id, {})).toEqual({ kind: 'approval_not_pending', status: 'expired' });

    expect(mustRun(h.store, run.id)).toMatchObject({ status: 'STOPPED', stopReason: 'approval_timeout' });
    outsideTheTransaction(measurements, [run.id]);
  });

  it('measures the grandchildren that a cancel reaches through a running child, before the transaction', () => {
    const { h, measurements } = measuring();
    const parent = enqueue(h.store, newSession(h.store).id);
    mustClaim(h.store, 'w-parent');
    const child = spawn(h.store, parent.id, 'call_child');
    mustClaim(h.store, 'w-child');
    expect(mustRun(h.store, child.id).status).toBe('RUNNING');
    const grandchild = spawn(h.store, child.id, 'call_grandchild');

    expect(cancel(h.store, parent.id).status).toBe('CANCELLING');

    expect(mustRun(h.store, grandchild.id).status).toBe('CANCELLED');
    outsideTheTransaction(measurements, [grandchild.id]);
  });

  it('measures the children of a child that waits for a person, before the transaction', () => {
    const { h, measurements } = measuring();
    const parent = enqueue(h.store, newSession(h.store).id);
    mustClaim(h.store, 'w-parent');
    const child = spawn(h.store, parent.id, 'call_child');
    const childClaim = mustClaim(h.store, 'w-child');
    const grandchild = spawn(h.store, child.id, 'call_grandchild');
    expect(h.store.append(childClaim, [callEvent('call_w')]).kind).toBe('ok');
    const approval = h.store.requestApproval(childClaim, {
      callId: 'call_w',
      options: [{ optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' }],
      expiresAt: EXPIRES_MS,
      event: { subjectDigest: 'a'.repeat(64), reason: 'edits require approval' },
    });
    expect(approval.kind).toBe('ok');
    expect(h.store.release(childClaim, 'WAITING_HUMAN').kind).toBe('ok');

    cancel(h.store, parent.id);

    expect(mustRun(h.store, child.id).status).toBe('CANCELLED');
    expect(mustRun(h.store, grandchild.id).status).toBe('CANCELLED');
    outsideTheTransaction(measurements, [child.id, grandchild.id]);
  });
});
