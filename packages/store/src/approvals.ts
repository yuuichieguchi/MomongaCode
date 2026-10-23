import type { DatabaseSync } from 'node:sqlite';
import { canonicalJson, immediateTx, uuidv7 } from '@momonga/foundation';
import type { Clock } from '@momonga/foundation';
import type { PermissionOption } from '@momonga/protocol';
import { corrupt, expectOneOf, isRecord, readerFor } from './rows.ts';
import type { Row } from './rows.ts';
import type { Approval, ApprovalCreateResult, Conflict, ApprovalResolveResult, ApprovalStore } from './types.ts';

const PERMISSION_KINDS = ['allow_once', 'allow_always', 'reject_once', 'reject_always'] as const;
const APPROVAL_STATUSES = ['pending', 'resolved', 'superseded'] as const;

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

export type ApprovalOps = {
  store: ApprovalStore;
  createWithinTransaction(input: Parameters<ApprovalStore['create']>[0], supersedeOnChange?: true): { kind: 'ok'; approval: Approval; created: boolean } | Conflict;
};

export const createApprovalStore = (db: DatabaseSync, clock: Clock): ApprovalOps => {
  const runExists = db.prepare('SELECT 1 AS present FROM runs WHERE id = :runId');
  const insert = db.prepare(
    `INSERT INTO approvals (id, run_id, call_id, status, options_json, expires_at, created_at, subject_digest)
     VALUES (:id, :runId, :callId, 'pending', :options, :expiresAt, :createdAt, :subjectDigest)`,
  );
  const selectPendingByCall = db.prepare("SELECT * FROM approvals WHERE run_id = :runId AND call_id = :callId AND status = 'pending'");
  const selectLatestByCall = db.prepare(
    'SELECT * FROM approvals WHERE run_id = :runId AND call_id = :callId ORDER BY created_at DESC, rowid DESC LIMIT 1',
  );
  const supersede = db.prepare("UPDATE approvals SET status = 'superseded' WHERE id = :id AND status = 'pending'");
  const selectById = db.prepare('SELECT * FROM approvals WHERE id = :id');
  const resolve = db.prepare(
    "UPDATE approvals SET status = 'resolved', option_id = :optionId, resolved_at = :resolvedAt WHERE id = :id AND status = 'pending'",
  );
  const listPending = db.prepare("SELECT * FROM approvals WHERE run_id = :runId AND status = 'pending' ORDER BY created_at, rowid");
  const listExpired = db.prepare("SELECT * FROM approvals WHERE status = 'pending' AND expires_at <= :nowMs ORDER BY expires_at, rowid");

  const get = (id: string): Approval | undefined => {
    const row = selectById.get({ id });
    return row === undefined ? undefined : decodeApproval(row);
  };

  const createWithinTransaction: ApprovalOps['createWithinTransaction'] = (input, supersedeOnChange) => {
    if (runExists.get({ runId: input.runId }) === undefined) throw new Error(`cannot create approval: unknown run ${input.runId}`);
    let pending = selectPendingByCall.get({ runId: input.runId, callId: input.callId });
    if (pending !== undefined && supersedeOnChange === true) {
      const current = decodeApproval(pending);
      if (canonicalJson(current.options) !== canonicalJson(input.options) || (current.subjectDigest ?? null) !== (input.subjectDigest ?? null)) {
        supersede.run({ id: current.id });
        pending = undefined;
      }
    }
    if (pending === undefined) {
      const latest = selectLatestByCall.get({ runId: input.runId, callId: input.callId });
      if (latest !== undefined && input.renewal !== true) {
        return { kind: 'conflict', reason: `approval ${String(latest['id'])} for run ${input.runId} call ${input.callId} is already resolved` };
      }
      insert.run({
        id: uuidv7(clock),
        runId: input.runId,
        callId: input.callId,
        options: canonicalJson(input.options),
        expiresAt: input.expiresAt,
        createdAt: clock.now(),
        subjectDigest: input.subjectDigest ?? null,
      });
    }
    const row = selectPendingByCall.get({ runId: input.runId, callId: input.callId });
    if (row === undefined) throw new Error(`approval for run ${input.runId} call ${input.callId} vanished during create`);
    const approval = decodeApproval(row);
    if (canonicalJson(approval.options) !== canonicalJson(input.options)) {
      return { kind: 'conflict', reason: `approval ${approval.id} for run ${input.runId} call ${input.callId} is pending with different options` };
    }
    return { kind: 'ok', approval, created: pending === undefined };
  };

  const store: ApprovalStore = {
    create: (input) => immediateTx<ApprovalCreateResult>(db, () => createWithinTransaction(input)),
    get,
    resolve: (id, resolution) =>
      immediateTx<ApprovalResolveResult>(db, () => {
        const current = get(id);
        if (current === undefined) return { kind: 'conflict', reason: `unknown approval ${id}` };
        if (current.status !== 'pending') return { kind: 'conflict', reason: `approval ${id} is already resolved` };
        if (!current.options.some((option) => option.optionId === resolution.optionId)) {
          return { kind: 'conflict', reason: `approval ${id} did not offer option "${resolution.optionId}"` };
        }
        const result = resolve.run({ id, optionId: resolution.optionId, resolvedAt: clock.now() });
        if (Number(result.changes) !== 1) throw new Error(`approval ${id} could not be resolved`);
        const approval = get(id);
        if (approval === undefined) throw new Error(`approval ${id} vanished during resolve`);
        return { kind: 'ok', approval };
      }),
    listPending: (runId) => listPending.all({ runId }).map(decodeApproval),
    listExpired: (nowMs) => listExpired.all({ nowMs }).map(decodeApproval),
  };
  return { store, createWithinTransaction };
};
