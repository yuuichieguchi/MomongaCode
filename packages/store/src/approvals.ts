import type { DatabaseSync } from 'node:sqlite';
import { canonicalJson, immediateTx, uuidv7 } from '@momonga/foundation';
import type { Clock } from '@momonga/foundation';
import { APPROVAL_STATUSES } from '@momonga/protocol';
import type { PermissionOption } from '@momonga/protocol';
import { corrupt, expectOneOf, isRecord, readerFor } from './rows.ts';
import type { Row } from './rows.ts';
import type { Approval, ApprovalStore } from './types.ts';

const PERMISSION_KINDS = ['allow_once', 'allow_always', 'reject_once', 'reject_always'] as const;

const decodeOptions = (identity: string, value: unknown): PermissionOption[] => {
  if (!Array.isArray(value)) throw corrupt('approvals', identity, 'column options_json must be a JSON array');
  return value.map((entry: unknown) => {
    if (!isRecord(entry) || typeof entry['optionId'] !== 'string' || typeof entry['name'] !== 'string' || typeof entry['kind'] !== 'string') {
      throw corrupt('approvals', identity, 'column options_json holds a malformed option');
    }
    return {
      optionId: entry['optionId'],
      name: entry['name'],
      kind: expectOneOf('approvals', identity, 'options_json', PERMISSION_KINDS, entry['kind']),
    };
  });
};

const decodeApproval = (row: Row): Approval => {
  const identity = String(row['id']);
  const reader = readerFor('approvals', identity, row);
  const optionId = reader.nullableString('option_id');
  const resolvedAt = reader.nullableNumber('resolved_at');
  const subjectDigest = reader.nullableString('subject_digest');
  return {
    id: reader.string('id'),
    runId: reader.string('run_id'),
    callId: reader.string('call_id'),
    status: expectOneOf('approvals', identity, 'status', APPROVAL_STATUSES, reader.string('status')),
    options: decodeOptions(identity, reader.json('options_json')),
    expiresAt: reader.number('expires_at'),
    createdAt: reader.number('created_at'),
    ...(optionId === null ? {} : { optionId }),
    ...(resolvedAt === null ? {} : { resolvedAt }),
    ...(subjectDigest === null ? {} : { subjectDigest }),
  };
};

export type ApprovalRequest = { runId: string; callId: string; options: PermissionOption[]; expiresAt: number; subjectDigest: string };

export type ApprovalOps = {
  store: ApprovalStore;
  request(input: ApprovalRequest): { approval: Approval; created: boolean; superseded?: Approval };
  listPendingDue(runId: string, nowMs: number): Approval[];
  markResolved(id: string, optionId: string): Approval;
  end(id: string, status: 'expired' | 'withdrawn'): void;
};

export const createApprovalStore = (db: DatabaseSync, clock: Clock): ApprovalOps => {
  const runExists = db.prepare('SELECT 1 AS present FROM runs WHERE id = :runId');
  const insert = db.prepare(
    `INSERT INTO approvals (id, run_id, call_id, status, options_json, expires_at, created_at, subject_digest)
     VALUES (:id, :runId, :callId, 'pending', :options, :expiresAt, :createdAt, :subjectDigest)`,
  );
  const selectPendingByCall = db.prepare("SELECT * FROM approvals WHERE run_id = :runId AND call_id = :callId AND status = 'pending'");
  const supersede = db.prepare("UPDATE approvals SET status = 'superseded' WHERE id = :id AND status = 'pending'");
  const selectById = db.prepare('SELECT * FROM approvals WHERE id = :id');
  const resolve = db.prepare(
    "UPDATE approvals SET status = 'resolved', option_id = :optionId, resolved_at = :resolvedAt WHERE id = :id AND status = 'pending'",
  );
  const finish = db.prepare("UPDATE approvals SET status = :status WHERE id = :id AND status = 'pending'");
  const listPending = db.prepare("SELECT * FROM approvals WHERE run_id = :runId AND status = 'pending' ORDER BY created_at, rowid");
  const listPendingDue = db.prepare(
    "SELECT * FROM approvals WHERE run_id = :runId AND status = 'pending' AND expires_at <= :nowMs ORDER BY expires_at, rowid",
  );

  const get = (id: string): Approval | undefined => {
    const row = selectById.get({ id });
    return row === undefined ? undefined : decodeApproval(row);
  };

  const mustGet = (id: string): Approval => {
    const approval = get(id);
    if (approval === undefined) throw new Error(`approval ${id} vanished`);
    return approval;
  };

  const insertPending = (input: ApprovalRequest): Approval => {
    const id = uuidv7(clock);
    insert.run({
      id,
      runId: input.runId,
      callId: input.callId,
      options: canonicalJson(input.options),
      expiresAt: input.expiresAt,
      createdAt: clock.now(),
      subjectDigest: input.subjectDigest,
    });
    return mustGet(id);
  };

  const request: ApprovalOps['request'] = (input) => {
    if (runExists.get({ runId: input.runId }) === undefined) throw new Error(`cannot create approval: unknown run ${input.runId}`);
    const pendingRow = selectPendingByCall.get({ runId: input.runId, callId: input.callId });
    if (pendingRow !== undefined) {
      const current = decodeApproval(pendingRow);
      if (canonicalJson(current.options) === canonicalJson(input.options) && current.subjectDigest === input.subjectDigest) {
        return { approval: current, created: false };
      }
      supersede.run({ id: current.id });
      return { approval: insertPending(input), created: true, superseded: mustGet(current.id) };
    }
    return { approval: insertPending(input), created: true };
  };

  const store: ApprovalStore = {
    get,
    listPending: (runId) => listPending.all({ runId }).map(decodeApproval),
  };
  return {
    store,
    request,
    listPendingDue: (runId, nowMs) => listPendingDue.all({ runId, nowMs }).map(decodeApproval),
    markResolved: (id, optionId) => {
      const result = resolve.run({ id, optionId, resolvedAt: clock.now() });
      if (Number(result.changes) !== 1) throw new Error(`approval ${id} could not be resolved`);
      return mustGet(id);
    },
    end: (id, status) => {
      const result = finish.run({ id, status });
      if (Number(result.changes) !== 1) throw new Error(`approval ${id} could not be marked ${status}`);
    },
  };
};
