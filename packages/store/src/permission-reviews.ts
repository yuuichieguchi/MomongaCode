import type { DatabaseSync } from 'node:sqlite';
import { REVIEW_LABELS } from '@momonga/protocol';
import type { PermissionReviewView, ReviewLabel, ReviewPage, RunCallView } from '@momonga/protocol';
import { readerFor, storedOneOf } from './rows.ts';
import type { DecodeContext } from './decode-context.ts';
import type { Row } from './rows.ts';

export type CallKey = { runId: string; callId: string };

export type PermissionReviewsStore = {
  page(cursor: string | null, limit: number): ReviewPage;
  label(review: CallKey & { label: ReviewLabel; reviewedAt: number }): 'stored' | 'unknown_call';
};

export type CallsReader = (after: CallKey | null, limit: number) => RunCallView[];

const CURSOR_SEPARATOR = '.';

const encodePart = (text: string): string => Buffer.from(text, 'utf8').toString('base64url');

const encodeCursor = (key: CallKey): string => `${encodePart(key.runId)}${CURSOR_SEPARATOR}${encodePart(key.callId)}`;

const decodeCursor = (cursor: string): CallKey => {
  const parts = cursor.split(CURSOR_SEPARATOR).map((part) => Buffer.from(part, 'base64url').toString('utf8'));
  const [runId, callId] = parts;
  if (parts.length !== 2 || runId === undefined || callId === undefined || runId === '' || callId === '' || encodeCursor({ runId, callId }) !== cursor) {
    throw new RangeError(`the cursor ${JSON.stringify(cursor)} was not issued by a page of reviews`);
  }
  return { runId, callId };
};

const reviewOf = (row: Row, context: DecodeContext): PermissionReviewView => {
  const identity = `${String(row['run_id'])}/${String(row['call_id'])}`;
  const reader = readerFor('permission_reviews', identity, row);
  return {
    runId: reader.string('run_id'),
    callId: reader.string('call_id'),
    label: storedOneOf(context, 'permission_reviews', identity, 'label', REVIEW_LABELS, reader.string('label')),
    reviewedAt: reader.number('reviewed_at'),
  };
};

export const createPermissionReviewsStore = (db: DatabaseSync, context: DecodeContext, calls: CallsReader): PermissionReviewsStore => {
  const reviewsBetween = db.prepare(
    `SELECT * FROM permission_reviews
     WHERE (run_id > :firstRun OR (run_id = :firstRun AND call_id >= :firstCall)) AND (run_id < :lastRun OR (run_id = :lastRun AND call_id <= :lastCall))
     ORDER BY run_id, call_id`,
  );
  const callExists = db.prepare('SELECT 1 AS found FROM run_calls WHERE run_id = :runId AND call_id = :callId');
  const upsert = db.prepare('INSERT OR REPLACE INTO permission_reviews (run_id, call_id, label, reviewed_at) VALUES (:runId, :callId, :label, :reviewedAt)');

  return {
    page: (cursor, limit) => {
      const found = calls(cursor === null ? null : decodeCursor(cursor), limit + 1);
      const shown = found.slice(0, limit);
      const first = shown[0];
      const last = shown.at(-1);
      if (first === undefined || last === undefined) return { calls: [], reviews: [], nextCursor: null };
      return {
        calls: shown,
        reviews: reviewsBetween.all({ firstRun: first.runId, firstCall: first.callId, lastRun: last.runId, lastCall: last.callId }).map((row) => reviewOf(row, context)),
        nextCursor: found.length > limit ? encodeCursor(last) : null,
      };
    },

    label: (review) => {
      if (callExists.get({ runId: review.runId, callId: review.callId }) === undefined) return 'unknown_call';
      upsert.run({ runId: review.runId, callId: review.callId, label: review.label, reviewedAt: review.reviewedAt });
      return 'stored';
    },
  };
};
