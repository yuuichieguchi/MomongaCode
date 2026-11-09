import type { DatabaseSync } from 'node:sqlite';
import { canonicalJson, immediateTx } from '@momonga/foundation';
import type { Clock } from '@momonga/foundation';
import { expectRecord, knownValue, readerFor, storedOneOf } from './rows.ts';
import type { DecodeContext } from './decode-context.ts';
import type { Row, Stored } from './rows.ts';
import type {
  IdempotencyBegin,
  IdempotencyLookup,
  IdempotencyRecord,
  IdempotencyStore,
  LeaseFence,
  LeasedBegin,
  LeasedIdempotency,
  LeasedOutcome,
} from './types.ts';

const OPEN_STATES = ['PENDING', 'UNKNOWN'] as const;

const decodeRecord = (row: Row, context: DecodeContext): Omit<IdempotencyRecord, 'state'> & { state: Stored<IdempotencyRecord['state']> } => {
  const key = String(row['key']);
  const reader = readerFor('idempotency', key, row);
  const pgid = reader.nullableNumber('pgid');
  const startedAt = reader.nullableNumber('started_at');
  const leaseToken = reader.nullableNumber('lease_token');
  return {
    key,
    state: storedOneOf(context, 'idempotency', key, 'state', OPEN_STATES, reader.string('state')),
    meta: expectRecord('idempotency', key, 'meta_json', reader.json('meta_json')),
    ...(pgid === null ? {} : { pgid }),
    ...(startedAt === null ? {} : { startedAt }),
    ...(leaseToken === null ? {} : { leaseToken }),
    createdAt: reader.number('created_at'),
    expiresAt: reader.number('expires_at'),
  };
};

export const createIdempotencyStore = (db: DatabaseSync, clock: Clock, holdsLease: (fence: LeaseFence) => boolean, context: DecodeContext): IdempotencyStore => {
  const insert = db.prepare(
    `INSERT INTO idempotency (key, state, meta_json, lease_token, created_at, expires_at)
     VALUES (:key, 'PENDING', :meta, :leaseToken, :createdAt, :expiresAt)
     ON CONFLICT (key) DO NOTHING`,
  );
  const select = db.prepare('SELECT * FROM idempotency WHERE key = :key');
  const attach = db.prepare(
    "UPDATE idempotency SET pgid = :pgid, started_at = :startedAt WHERE key = :key AND state = 'PENDING'",
  );
  const adopt = db.prepare("UPDATE idempotency SET lease_token = :leaseToken WHERE key = :key AND state IN ('PENDING', 'UNKNOWN')");
  const setCheckpoint = db.prepare(
    "UPDATE idempotency SET meta_json = json_set(meta_json, '$.checkpoint', json(:state)) WHERE key = :key AND state = 'PENDING'",
  );
  const clearCheckpoint = db.prepare("UPDATE idempotency SET meta_json = json_remove(meta_json, '$.checkpoint') WHERE key = :key AND state = 'PENDING'");
  const complete = db.prepare(
    "UPDATE idempotency SET state = 'COMPLETED', result_json = :result WHERE key = :key AND state IN ('PENDING', 'UNKNOWN')",
  );
  const completeWithMeta = db.prepare(
    "UPDATE idempotency SET state = 'COMPLETED', result_json = :result, meta_json = json_patch(meta_json, :meta) WHERE key = :key AND state IN ('PENDING', 'UNKNOWN')",
  );
  const markUnknown = db.prepare("UPDATE idempotency SET state = 'UNKNOWN' WHERE key = :key AND state = 'PENDING'");
  const purge = db.prepare('DELETE FROM idempotency WHERE expires_at <= :nowMs');

  const requireChange = (changes: number | bigint, key: string, action: string, expectedStates: string): void => {
    if (Number(changes) !== 1) {
      throw new Error(`cannot ${action} idempotency key "${key}": no record in state ${expectedStates}`);
    }
  };

  const lookupRow = (key: string, row: Row): IdempotencyLookup => {
    const reader = readerFor('idempotency', key, row);
    if (reader.string('state') === 'COMPLETED') return { s: 'COMPLETED', result: reader.json('result_json') };
    const stored = decodeRecord(row, context);
    const rec = { ...stored, state: knownValue(stored.state, `idempotency key ${key}`) };
    return rec.state === 'PENDING' ? { s: 'PENDING', rec } : { s: 'UNKNOWN', rec };
  };

  const beginRecord = (key: string, options: { expiresAt: number; meta: Record<string, unknown> }, leaseToken: number | null): IdempotencyBegin => {
    const inserted = insert.run({
      key,
      meta: canonicalJson(options.meta),
      leaseToken,
      createdAt: clock.now(),
      expiresAt: options.expiresAt,
    });
    if (Number(inserted.changes) === 1) return { s: 'NEW' };
    const row = select.get({ key });
    if (row === undefined) throw new Error(`idempotency key "${key}" vanished during begin`);
    return lookupRow(key, row);
  };

  const attachRecord = (key: string, process: { pgid: number; startedAt: number }): void => {
    requireChange(attach.run({ key, pgid: process.pgid, startedAt: process.startedAt }).changes, key, 'attach a process to', 'PENDING');
  };

  const completeRecord = (key: string, result: unknown, meta?: Record<string, unknown>): void => {
    const changes =
      meta === undefined
        ? complete.run({ key, result: canonicalJson(result) }).changes
        : completeWithMeta.run({ key, result: canonicalJson(result), meta: canonicalJson(meta) }).changes;
    requireChange(changes, key, 'complete', 'PENDING or UNKNOWN');
  };

  const leasedBy = (fence: LeaseFence): LeasedIdempotency => {
    const lost: LeasedOutcome = { kind: 'lease_lost' };
    const ok: LeasedOutcome = { kind: 'ok' };
    const whileHolding = (write: () => void): LeasedOutcome =>
      immediateTx<LeasedOutcome>(db, () => {
        if (!holdsLease(fence)) return lost;
        write();
        return ok;
      });
    return {
      begin: (key, options) =>
        immediateTx<LeasedBegin>(db, () => (holdsLease(fence) ? beginRecord(key, options, fence.leaseToken) : { s: 'LEASE_LOST' })),
      authorise: (key) =>
        whileHolding(() => {
          requireChange(adopt.run({ key, leaseToken: fence.leaseToken }).changes, key, 'authorise', 'PENDING or UNKNOWN');
        }),
      attachProcess: (key, process) => whileHolding(() => attachRecord(key, process)),
      checkpoint: (key, state) =>
        whileHolding(() => {
          const changes = state === undefined ? clearCheckpoint.run({ key }).changes : setCheckpoint.run({ key, state: canonicalJson(state) }).changes;
          requireChange(changes, key, 'checkpoint', 'PENDING');
        }),
      complete: (key, result, meta) => whileHolding(() => completeRecord(key, result, meta)),
    };
  };

  return {
    get: (key) => {
      const row = select.get({ key });
      return row === undefined ? undefined : lookupRow(key, row);
    },
    holding: leasedBy,
    clearCheckpoint: (key) => {
      requireChange(clearCheckpoint.run({ key }).changes, key, 'checkpoint', 'PENDING');
    },
    begin: (key, options) => immediateTx<IdempotencyBegin>(db, () => beginRecord(key, options, null)),
    attachProcess: attachRecord,
    complete: completeRecord,
    markUnknown: (key) => {
      requireChange(markUnknown.run({ key }).changes, key, 'mark unknown', 'PENDING');
    },
    markUnknownIfPending: (key) => Number(markUnknown.run({ key }).changes) === 1,
    purgeExpired: (nowMs) => Number(purge.run({ nowMs }).changes),
  };
};
