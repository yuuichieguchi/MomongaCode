import type { DatabaseSync } from 'node:sqlite';
import { canonicalJson } from '@momonga/foundation';
import type { Clock } from '@momonga/foundation';
import { IMAGE_MEDIA_TYPES, INBOX_DELIVERIES, INBOX_STATES, MEMORY_ORIGINS, TERMINAL_STATUSES, base64ByteLength } from '@momonga/protocol';
import type { ImageAttachment, InboxDelivery, InboxRowView, InboxState, Mandate, MemoryOrigin, Stored } from '@momonga/protocol';
import type { DecodeContext } from './decode-context.ts';
import { corrupt, isRecord, readerFor, storedOneOf } from './rows.ts';
import type { Row } from './rows.ts';
import type { InboxRow, QueuedRunTerms } from './types.ts';

const TABLE = 'run_inbox';

const TERMINAL_LIST = TERMINAL_STATUSES.map((status) => `'${status}'`).join(', ');

const imageOf = (identity: string, value: unknown): ImageAttachment => {
  if (!isRecord(value) || typeof value['data'] !== 'string' || typeof value['mediaType'] !== 'string') throw corrupt(TABLE, identity, 'attachments must hold mediaType and data entries');
  const mediaType = IMAGE_MEDIA_TYPES.find((candidate) => candidate === value['mediaType']);
  if (mediaType === undefined) throw corrupt(TABLE, identity, `attachments holds the unknown media type ${JSON.stringify(value['mediaType'])}`);
  return { mediaType, data: value['data'] };
};

const recordOf = (identity: string, value: unknown, what: string): Record<string, unknown> => {
  if (!isRecord(value)) throw corrupt(TABLE, identity, `run_terms_json ${what} must be an object`);
  return value;
};

const termsOf = (identity: string, text: string): QueuedRunTerms => {
  const parsed = recordOf(identity, JSON.parse(text), 'itself');
  const { timeoutMs, mandate } = parsed;
  if (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs) || timeoutMs < 1) throw corrupt(TABLE, identity, 'run_terms_json timeoutMs must be a positive integer');
  const terms = { timeoutMs, limits: recordOf(identity, parsed['limits'], 'limits'), pins: recordOf(identity, parsed['pins'], 'pins') };
  return mandate === undefined ? terms : { ...terms, mandate: recordOf(identity, mandate, 'mandate') as Mandate };
};

const queuedOf = (context: DecodeContext, identity: string, terms: string | null, origin: string | null): InboxRow['queued'] => {
  if (terms === null && origin === null) return null;
  if (terms === null || origin === null) throw corrupt(TABLE, identity, 'run_terms_json and origin are written together');
  const stored: Stored<MemoryOrigin> = storedOneOf(context, TABLE, identity, 'origin', MEMORY_ORIGINS, origin);
  return { terms: termsOf(identity, terms), origin: stored };
};

const decodeRow = (row: Row, context: DecodeContext): InboxRow => {
  const identity = String(row['id']);
  const reader = readerFor(TABLE, identity, row);
  const attachments = reader.json('attachments');
  if (!Array.isArray(attachments)) throw corrupt(TABLE, identity, 'attachments must be a list');
  return {
    id: reader.string('id'),
    sessionId: reader.string('session_id'),
    delivery: storedOneOf(context, TABLE, identity, 'delivery', INBOX_DELIVERIES, reader.string('delivery')),
    text: reader.string('text'),
    ...(attachments.length === 0 ? {} : { images: attachments.map((entry) => imageOf(identity, entry)) }),
    seq: reader.number('seq'),
    state: storedOneOf(context, TABLE, identity, 'state', INBOX_STATES, reader.string('state')),
    createdAt: reader.number('created_at'),
    settledAt: reader.nullableNumber('settled_at'),
    queued: queuedOf(context, identity, reader.nullableString('run_terms_json'), reader.nullableString('origin')),
  };
};

export const inboxRowView = (row: InboxRow): InboxRowView => {
  const { images, queued: _queued, ...rest } = row;
  return { ...rest, ...(images === undefined ? {} : { images: images.map((image) => ({ mediaType: image.mediaType, byteLength: base64ByteLength(image.data) })) }) };
};

export type InboxTable = {
  insert(input: { id: string; sessionId: string; delivery: InboxDelivery; text: string; images: readonly ImageAttachment[] | undefined; terms: QueuedRunTerms; origin: MemoryOrigin }): InboxRow;
  get(id: string): InboxRow | undefined;
  pending(sessionId: string): InboxRow[];
  pendingCount(sessionId: string): number;
  pendingSteer(sessionId: string): InboxRow[];
  firstQueued(sessionId: string): InboxRow | undefined;
  settle(id: string, state: Exclude<InboxState, 'pending'>): boolean;
  queuePendingSteer(sessionId: string): number;
  sessionHasOpenRun(sessionId: string): boolean;
  nextRunAfter(runId: string): Row | undefined;
};

export const createInboxTable = (db: DatabaseSync, clock: Clock, context: DecodeContext): InboxTable => {
  const sql = {
    nextSeq: db.prepare(`SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM ${TABLE} WHERE session_id = :sessionId`),
    insert: db.prepare(
      `INSERT INTO ${TABLE} (id, session_id, delivery, text, attachments, seq, state, created_at, settled_at, run_terms_json, origin)
       VALUES (:id, :sessionId, :delivery, :text, :attachments, :seq, 'pending', :createdAt, NULL, :terms, :origin)`,
    ),
    byId: db.prepare(`SELECT * FROM ${TABLE} WHERE id = :id`),
    pending: db.prepare(`SELECT * FROM ${TABLE} WHERE session_id = :sessionId AND state = 'pending' ORDER BY seq`),
    pendingCount: db.prepare(`SELECT COUNT(*) AS pending FROM ${TABLE} WHERE session_id = :sessionId AND state = 'pending'`),
    pendingSteer: db.prepare(`SELECT * FROM ${TABLE} WHERE session_id = :sessionId AND state = 'pending' AND delivery = 'steer' ORDER BY seq`),
    firstQueued: db.prepare(`SELECT * FROM ${TABLE} WHERE session_id = :sessionId AND state = 'pending' AND delivery = 'queue' AND run_terms_json IS NOT NULL ORDER BY seq LIMIT 1`),
    settle: db.prepare(`UPDATE ${TABLE} SET state = :state, settled_at = :settledAt WHERE id = :id AND state = 'pending'`),
    queuePendingSteer: db.prepare(`UPDATE ${TABLE} SET delivery = 'queue' WHERE session_id = :sessionId AND state = 'pending' AND delivery = 'steer'`),
    openRun: db.prepare(`SELECT EXISTS (SELECT 1 FROM runs WHERE session_id = :sessionId AND status NOT IN (${TERMINAL_LIST})) AS open`),
    nextRunAfter: db.prepare(
      `SELECT next.* FROM runs next JOIN runs ended ON ended.id = :runId
       WHERE next.session_id = ended.session_id AND next.ordinal > ended.ordinal ORDER BY next.ordinal LIMIT 1`,
    ),
  };

  const get = (id: string): InboxRow | undefined => {
    const row = sql.byId.get({ id });
    return row === undefined ? undefined : decodeRow(row, context);
  };

  const numberOf = (row: Row | undefined, sessionId: string, column: string): number => {
    if (row === undefined) throw new Error(`could not read ${column} of the inbox of session ${sessionId}`);
    return readerFor(TABLE, sessionId, row).number(column);
  };

  return {
    insert: (input) => {
      sql.insert.run({
        id: input.id,
        sessionId: input.sessionId,
        delivery: input.delivery,
        text: input.text,
        attachments: canonicalJson(input.images ?? []),
        seq: numberOf(sql.nextSeq.get({ sessionId: input.sessionId }), input.sessionId, 'next'),
        createdAt: clock.now(),
        terms: canonicalJson(input.terms),
        origin: input.origin,
      });
      const row = get(input.id);
      if (row === undefined) throw new Error(`inbox row ${input.id} vanished after it was written`);
      return row;
    },
    get,
    pending: (sessionId) => sql.pending.all({ sessionId }).map((row) => decodeRow(row, context)),
    pendingCount: (sessionId) => numberOf(sql.pendingCount.get({ sessionId }), sessionId, 'pending'),
    pendingSteer: (sessionId) => sql.pendingSteer.all({ sessionId }).map((row) => decodeRow(row, context)),
    firstQueued: (sessionId) => {
      const row = sql.firstQueued.get({ sessionId });
      return row === undefined ? undefined : decodeRow(row, context);
    },
    settle: (id, state) => Number(sql.settle.run({ id, state, settledAt: clock.now() }).changes) === 1,
    queuePendingSteer: (sessionId) => Number(sql.queuePendingSteer.run({ sessionId }).changes),
    sessionHasOpenRun: (sessionId) => numberOf(sql.openRun.get({ sessionId }), sessionId, 'open') === 1,
    nextRunAfter: (runId) => sql.nextRunAfter.get({ runId }),
  };
};
