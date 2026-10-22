import type { DatabaseSync } from 'node:sqlite';
import { canonicalJson, immediateTx } from '@momonga/foundation';
import type { Clock } from '@momonga/foundation';
import { expectOneOf, expectRecord, readerFor } from './rows.ts';
import type { Row } from './rows.ts';
import type { IdempotencyBegin, IdempotencyRecord, IdempotencyStore } from './types.ts';

const OPEN_STATES = ['PENDING', 'UNKNOWN'] as const;

const decodeRecord = (row: Row): IdempotencyRecord => {
  const key = String(row['key']);
  const reader = readerFor('idempotency', key, row);
  const pgid = reader.nullableNumber('pgid');
  const startedAt = reader.nullableNumber('started_at');
  return {
    key,
    state: expectOneOf('idempotency', key, 'state', OPEN_STATES, reader.string('state')),
    meta: expectRecord('idempotency', key, 'meta_json', reader.json('meta_json')),
    ...(pgid === null ? {} : { pgid }),
    ...(startedAt === null ? {} : { startedAt }),
    createdAt: reader.number('created_at'),
    expiresAt: reader.number('expires_at'),
  };
};

export const createIdempotencyStore = (db: DatabaseSync, clock: Clock): IdempotencyStore => {
  const insert = db.prepare(
    `INSERT INTO idempotency (key, state, meta_json, created_at, expires_at)
     VALUES (:key, 'PENDING', :meta, :createdAt, :expiresAt)
     ON CONFLICT (key) DO NOTHING`,
  );
  const select = db.prepare('SELECT * FROM idempotency WHERE key = :key');
  const attach = db.prepare(
    "UPDATE idempotency SET pgid = :pgid, started_at = :startedAt WHERE key = :key AND state = 'PENDING'",
  );
  const complete = db.prepare(
    "UPDATE idempotency SET state = 'COMPLETED', result_json = :result WHERE key = :key AND state IN ('PENDING', 'UNKNOWN')",
  );
  const markUnknown = db.prepare("UPDATE idempotency SET state = 'UNKNOWN' WHERE key = :key AND state = 'PENDING'");
  const purge = db.prepare('DELETE FROM idempotency WHERE expires_at <= :nowMs');

  const requireChange = (changes: number | bigint, key: string, action: string, expectedStates: string): void => {
    if (Number(changes) !== 1) {
      throw new Error(`cannot ${action} idempotency key "${key}": no record in state ${expectedStates}`);
    }
  };

  return {
    begin: (key, options) =>
      immediateTx<IdempotencyBegin>(db, () => {
        const inserted = insert.run({
          key,
          meta: canonicalJson(options.meta),
          createdAt: clock.now(),
          expiresAt: options.expiresAt,
        });
        if (Number(inserted.changes) === 1) return { s: 'NEW' };
        const row = select.get({ key });
        if (row === undefined) throw new Error(`idempotency key "${key}" vanished during begin`);
        const state = readerFor('idempotency', key, row).string('state');
        if (state === 'COMPLETED') return { s: 'COMPLETED', result: readerFor('idempotency', key, row).json('result_json') };
        const rec = decodeRecord(row);
        return rec.state === 'PENDING' ? { s: 'PENDING', rec } : { s: 'UNKNOWN', rec };
      }),
    attachProcess: (key, process) => {
      requireChange(attach.run({ key, pgid: process.pgid, startedAt: process.startedAt }).changes, key, 'attach a process to', 'PENDING');
    },
    complete: (key, result) => {
      requireChange(complete.run({ key, result: canonicalJson(result) }).changes, key, 'complete', 'PENDING or UNKNOWN');
    },
    markUnknown: (key) => {
      requireChange(markUnknown.run({ key }).changes, key, 'mark unknown', 'PENDING');
    },
    purgeExpired: (nowMs) => Number(purge.run({ nowMs }).changes),
  };
};
