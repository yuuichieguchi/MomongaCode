import type { DatabaseSync } from 'node:sqlite';
import { setImmediate as eventLoopTurn } from 'node:timers/promises';
import { readTx } from '@momonga/foundation/sqlite';
import type { RunEvent, RunEventPayload, SessionEventPayload } from '@momonga/protocol';
import { APPEND_TIME_RECORDS_DERIVATION, INDEXED_CHARS_DERIVATION, RECORD_DERIVATIONS, RUN_ANSWERERS_DERIVATION, SESSION_TOUCHED_DERIVATION, columnsOf } from './append-records.ts';
import type { AppendRecordReaders, AppendRecords, RecordDerivation, RecordedEvent } from './append-records.ts';
import { decodeRunEvents } from './codec.ts';
import type { DecodeContext } from './codec.ts';
import { decodeContextOf } from './decode-context.ts';
import { readerFor } from './rows.ts';
import type { Row } from './rows.ts';

export const PINNED_DIGEST_DERIVATION = 14;

export const DERIVATIONS = [PINNED_DIGEST_DERIVATION, ...RECORD_DERIVATIONS] as const;

type Derivation = (typeof DERIVATIONS)[number];

export const REPAIR_PAGE_EVENTS = 500;

export const DERIVED_VALUES = [
  { derivation: PINNED_DIGEST_DERIVATION, holds: 'events.pinned_digest', scope: 'run' },
  { derivation: APPEND_TIME_RECORDS_DERIVATION, holds: 'events.call_id', scope: 'run' },
  { derivation: APPEND_TIME_RECORDS_DERIVATION, holds: 'events.approval_id', scope: 'run' },
  { derivation: APPEND_TIME_RECORDS_DERIVATION, holds: 'events.tool_name', scope: 'run' },
  { derivation: APPEND_TIME_RECORDS_DERIVATION, holds: 'events.notice_code', scope: 'run' },
  { derivation: APPEND_TIME_RECORDS_DERIVATION, holds: 'events.model_call_json', scope: 'run' },
  { derivation: APPEND_TIME_RECORDS_DERIVATION, holds: 'run_records', scope: 'run' },
  { derivation: APPEND_TIME_RECORDS_DERIVATION, holds: 'started_calls', scope: 'run' },
  { derivation: APPEND_TIME_RECORDS_DERIVATION, holds: 'meter_records', scope: 'session' },
  { derivation: SESSION_TOUCHED_DERIVATION, holds: 'session_touched', scope: 'session' },
  { derivation: RUN_ANSWERERS_DERIVATION, holds: 'run_answerers', scope: 'run' },
  { derivation: INDEXED_CHARS_DERIVATION, holds: 'run_indexed_chars', scope: 'run' },
] as const;

export type DerivedScope = { readonly runId: string } | { readonly sessionId: string } | { readonly runTree: string };

export const pinnedDigestOf = (payload: RunEventPayload | SessionEventPayload): string | null => (payload.type === 'model.requested' ? (payload.pinnedDigest ?? null) : null);

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
      sql.fillPinned.run({ id: event.id, pinnedDigest: pinnedDigestOf(event) });
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

const TREE_OF = 'WITH RECURSIVE tree(id) AS (SELECT :runTree UNION ALL SELECT c.id FROM runs c JOIN tree t ON c.parent_run_id = t.id) SELECT id FROM tree';

const LAGGING = `r.last_seq > 0 AND (SELECT COUNT(*) FROM derived_through d WHERE d.run_id = r.id AND d.through_seq >= r.last_seq) < ${DERIVATIONS.length}`;

export type DerivedReads = {
  read<T>(scope: DerivedScope, readCurrent: (view: AppendRecordReaders) => T): Promise<T>;
  write<T>(scope: DerivedScope, writeCurrent: (view: AppendRecordReaders) => T): Promise<T>;
  readonly view: AppendRecordReaders;
};

export const createDerivedReads = (db: DatabaseSync, repair: DerivedRepair, records: AppendRecordReaders, transaction: <T>(fn: () => T) => T): DerivedReads => {
  const lagging = {
    run: db.prepare(`SELECT r.id, r.last_seq FROM runs r WHERE r.id = :runId AND ${LAGGING}`),
    session: db.prepare(`SELECT r.id, r.last_seq FROM runs r WHERE r.session_id = :sessionId AND ${LAGGING} ORDER BY r.rowid LIMIT 1`),
    tree: db.prepare(`SELECT r.id, r.last_seq FROM runs r WHERE r.id IN (${TREE_OF}) AND ${LAGGING} ORDER BY r.rowid LIMIT 1`),
  };

  const laggingRunOf = (scope: DerivedScope): { runId: string; lastSeq: number } | undefined => {
    const row = 'runId' in scope ? lagging.run.get({ runId: scope.runId }) : 'sessionId' in scope ? lagging.session.get({ sessionId: scope.sessionId }) : lagging.tree.get({ runTree: scope.runTree });
    if (row === undefined) return undefined;
    const reader = readerFor('runs', String(row['id']), row);
    return { runId: reader.string('id'), lastSeq: reader.number('last_seq') };
  };

  let current = false;

  const within = <T>(fn: (view: AppendRecordReaders) => T): T => {
    const outer = current;
    current = true;
    try {
      return fn(view);
    } finally {
      current = outer;
    }
  };

  const guarded =
    <A extends unknown[], R>(reader: (...args: A) => R) =>
    (...args: A): R => {
      if (!current) throw new Error('a derived record is read outside the read function of the store, so it may lag its events');
      return reader(...args);
    };

  const view: AppendRecordReaders = {
    toolCallSeq: guarded(records.toolCallSeq),
    modelCallRowsOf: guarded(records.modelCallRowsOf),
    toolCallNamesOf: guarded(records.toolCallNamesOf),
    finalTextOf: guarded(records.finalTextOf),
    inFlightModelRequestOf: guarded(records.inFlightModelRequestOf),
    startedCallsOf: guarded(records.startedCallsOf),
    hasNoticeCode: guarded(records.hasNoticeCode),
    meterRecordOf: guarded(records.meterRecordOf),
    answeringTargetsOf: guarded(records.answeringTargetsOf),
    indexedCharsOf: guarded(records.indexedCharsOf),
    touchedAfter: guarded(records.touchedAfter),
    touchedNewest: guarded(records.touchedNewest),
    permissionRequestOf: guarded(records.permissionRequestOf),
    elicitationRequested: guarded(records.elicitationRequested),
    unknownRequestOf: guarded(records.unknownRequestOf),
    reconciledOf: guarded(records.reconciledOf),
    toolCallEventOf: guarded(records.toolCallEventOf),
  };

  const paged = async <T>(scope: DerivedScope, fn: (view: AppendRecordReaders) => T): Promise<T> => {
    for (;;) {
      const outcome = transaction((): { value: T } | undefined => {
        const behind = laggingRunOf(scope);
        if (behind !== undefined) {
          repair.repairPage(behind.runId, behind.lastSeq);
          if (laggingRunOf(scope) !== undefined) return undefined;
        }
        return { value: within(fn) };
      });
      if (outcome !== undefined) return outcome.value;
      await eventLoopTurn();
    }
  };

  const read = async <T>(scope: DerivedScope, readCurrent: (view: AppendRecordReaders) => T): Promise<T> => {
    const quiet = readTx(db, (): { value: T } | undefined => (laggingRunOf(scope) === undefined ? { value: within(readCurrent) } : undefined));
    return quiet === undefined ? paged(scope, readCurrent) : quiet.value;
  };

  return { read, write: paged, view };
};

export type DerivedSnapshotView = {
  pinnedDigestsOf(runId: string): { seq: number; pinnedDigest: string | null }[];
  callOwnersOf(sessionId: string, callId: string): string[];
  toolCallOf(runId: string, callId: string): RunEvent | undefined;
};

export type DerivedSnapshot = {
  read<T>(readCurrent: (view: DerivedSnapshotView) => T): T;
};

const pastMark = (derivation: Derivation): string =>
  `e.seq > COALESCE((SELECT d.through_seq FROM derived_through d WHERE d.run_id = e.run_id AND d.derivation = ${derivation}), 0)`;

export const createDerivedSnapshot = (db: DatabaseSync, decodeContext: DecodeContext = decodeContextOf(db)): DerivedSnapshot => {
  const sql = {
    pinned: db.prepare(`SELECT e.*, ${pastMark(PINNED_DIGEST_DERIVATION)} AS past FROM events e WHERE e.run_id = :runId AND e.type = 'model.requested' ORDER BY e.seq`),
    callOwners: db.prepare(
      `SELECT e.*, ${pastMark(APPEND_TIME_RECORDS_DERIVATION)} AS past FROM events e
       WHERE e.type = 'tool.call' AND e.run_id IN (SELECT id FROM runs WHERE session_id = :sessionId)
         AND (e.call_id = :callId OR (e.call_id IS NULL AND ${pastMark(APPEND_TIME_RECORDS_DERIVATION)}))
       ORDER BY e.id`,
    ),
    toolCall: db.prepare(
      `SELECT e.*, ${pastMark(APPEND_TIME_RECORDS_DERIVATION)} AS past FROM events e
       WHERE e.run_id = :runId AND e.type = 'tool.call' AND (e.call_id = :callId OR (e.call_id IS NULL AND ${pastMark(APPEND_TIME_RECORDS_DERIVATION)}))
       ORDER BY e.seq`,
    ),
  };

  const isCall = (identity: string, callId: string, row: Row): boolean => readerFor('events', identity, row).number('past') === 0 || columnsOf(derivedEventOf(row)).callId === callId;

  const derivedEventOf = (row: Row): RunEvent => {
    const [event] = decodeRunEvents([row], decodeContext);
    if (event === undefined) throw new Error(`event ${String(row['id'])} decodes to no run event`);
    return event;
  };

  const view: DerivedSnapshotView = {
    pinnedDigestsOf: (runId) =>
      sql.pinned.all({ runId }).map((row) => {
        const reader = readerFor('events', runId, row);
        return { seq: reader.number('seq'), pinnedDigest: reader.number('past') === 1 ? pinnedDigestOf(derivedEventOf(row)) : reader.nullableString('pinned_digest') };
      }),
    callOwnersOf: (sessionId, callId) =>
      sql.callOwners
        .all({ sessionId, callId })
        .filter((row) => isCall(sessionId, callId, row))
        .map((row) => readerFor('events', sessionId, row).string('run_id')),
    toolCallOf: (runId, callId) => {
      const row = sql.toolCall.all({ runId, callId }).find((candidate) => isCall(runId, callId, candidate));
      return row === undefined ? undefined : derivedEventOf(row);
    },
  };

  return { read: (readCurrent) => (db.isTransaction ? readCurrent(view) : readTx(db, () => readCurrent(view))) };
};
