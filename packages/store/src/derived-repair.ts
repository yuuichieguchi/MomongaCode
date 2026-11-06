import type { DatabaseSync } from 'node:sqlite';
import type { RunEvent } from '@momonga/protocol';
import { APPEND_TIME_RECORDS_DERIVATION, RECORD_DERIVATIONS, columnsOf } from './append-records.ts';
import type { AppendRecords, RecordDerivation, RecordedEvent } from './append-records.ts';
import { decodeRunEvents } from './codec.ts';
import type { DecodeContext } from './codec.ts';
import { readerFor } from './rows.ts';

export const PINNED_DIGEST_DERIVATION = 14;

export const DERIVATIONS = [PINNED_DIGEST_DERIVATION, ...RECORD_DERIVATIONS] as const;

type Derivation = (typeof DERIVATIONS)[number];

export const REPAIR_PAGE_EVENTS = 500;

export type DerivedRepair = {
  recordAppended(event: RecordedEvent): void;
  repairPage(runId: string, throughSeq: number): boolean;
};

const isRecordDerivation = (derivation: Derivation): derivation is RecordDerivation => derivation !== PINNED_DIGEST_DERIVATION;

export const createDerivedRepair = (db: DatabaseSync, records: AppendRecords, decodeContext: DecodeContext): DerivedRepair => {
  const sql = {
    watermarks: db.prepare('SELECT derivation, through_seq FROM derived_through WHERE run_id = :runId'),
    advance: db.prepare(
      `INSERT INTO derived_through (run_id, derivation, through_seq) VALUES (:runId, :derivation, :seq)
       ON CONFLICT (run_id, derivation) DO UPDATE SET through_seq = excluded.through_seq`,
    ),
    advanceAll: db.prepare(
      `INSERT INTO derived_through (run_id, derivation, through_seq) VALUES ${DERIVATIONS.map((derivation) => `(:runId, ${derivation}, :seq)`).join(', ')}
       ON CONFLICT (run_id, derivation) DO UPDATE SET through_seq = excluded.through_seq`,
    ),
    tail: db.prepare('SELECT * FROM events WHERE run_id = :runId AND seq > :after AND seq <= :through ORDER BY seq LIMIT :limit'),
    fillPinned: db.prepare('UPDATE events SET pinned_digest = :pinnedDigest WHERE id = :id AND pinned_digest IS NULL AND :pinnedDigest IS NOT NULL'),
    fillColumns: db.prepare(
      `UPDATE events SET call_id = COALESCE(call_id, :callId), approval_id = COALESCE(approval_id, :approvalId), tool_name = COALESCE(tool_name, :toolName),
         notice_code = COALESCE(notice_code, :noticeCode), model_call_json = COALESCE(model_call_json, :modelCallJson)
       WHERE id = :id AND ((call_id IS NULL AND :callId IS NOT NULL) OR (approval_id IS NULL AND :approvalId IS NOT NULL) OR (tool_name IS NULL AND :toolName IS NOT NULL)
         OR (notice_code IS NULL AND :noticeCode IS NOT NULL) OR (model_call_json IS NULL AND :modelCallJson IS NOT NULL))`,
    ),
  };

  const watermarksOf = (runId: string): Map<number, number> =>
    new Map(
      sql.watermarks.all({ runId }).map((row) => {
        const reader = readerFor('derived_through', runId, row);
        return [reader.number('derivation'), reader.number('through_seq')];
      }),
    );

  const apply = (derivation: Derivation, event: RunEvent): void => {
    if (derivation === PINNED_DIGEST_DERIVATION) {
      sql.fillPinned.run({ id: event.id, pinnedDigest: event.type === 'model.requested' ? (event.pinnedDigest ?? null) : null });
      return;
    }
    if (derivation === APPEND_TIME_RECORDS_DERIVATION) sql.fillColumns.run({ id: event.id, ...columnsOf(event) });
    if (isRecordDerivation(derivation)) records.recordFor(derivation, { eventId: event.id, runId: event.runId, sessionId: event.sessionId, seq: event.seq, step: event.step, payload: event });
  };

  const repairPage = (runId: string, throughSeq: number): boolean => {
    const marks = watermarksOf(runId);
    let caughtUp = true;
    for (const derivation of DERIVATIONS) {
      const after = marks.get(derivation) ?? 0;
      if (after >= throughSeq) continue;
      const rows = sql.tail.all({ runId, after, through: throughSeq, limit: REPAIR_PAGE_EVENTS });
      for (const event of decodeRunEvents(rows, decodeContext)) apply(derivation, event);
      const last = rows.at(-1);
      const reached = last === undefined || rows.length < REPAIR_PAGE_EVENTS ? throughSeq : readerFor('events', runId, last).number('seq');
      sql.advance.run({ runId, derivation, seq: reached });
      if (reached < throughSeq) caughtUp = false;
    }
    return caughtUp;
  };

  const recordAppended = (event: RecordedEvent): void => {
    const marks = watermarksOf(event.runId);
    if (DERIVATIONS.some((derivation) => (marks.get(derivation) ?? 0) !== event.seq - 1)) return;
    records.record(event);
    sql.advanceAll.run({ runId: event.runId, seq: event.seq });
  };

  return { recordAppended, repairPage };
};
