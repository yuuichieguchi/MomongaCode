import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { canonicalJson, immediateTx, migrate, openDatabase, readTx, uuidv7 } from '@momonga/foundation';
import { TERMINAL_STATUSES, TOOL_KINDS } from '@momonga/protocol';
import type { PermissionMode, RunEventPayload, RunStatus, SessionEventPayload } from '@momonga/protocol';
import { createApprovalStore } from './approvals.ts';
import { createBlobStore, prepareBlobDirectory } from './blobs.ts';
import { decodeEvent, decodeRun, decodeRunEvents, decodeRunState, decodeSession, encodeRunState } from './codec.ts';
import { StoreIdentityError } from './fatal.ts';
import { createIdempotencyStore } from './idempotency.ts';
import { corrupt, expectOneOf, expectRecord, isRecord, readerFor } from './rows.ts';
import type { Row } from './rows.ts';
import { sameRunRequest } from './run-request.ts';
import { MIGRATIONS } from './schema.ts';
import { createTrustStore } from './trust.ts';
import type {
  Approval,
  ApprovalView,
  Claim,
  ClaimStatus,
  Conflict,
  CreateRunResult,
  HeartbeatResult,
  LeaseLost,
  LoadedRun,
  Run,
  RequestApprovalResult,
  RequestCancelResult,
  ResolveApprovalResult,
  RunMutationResult,
  RuntimeStore,
  RuntimeStoreOptions,
  ServiceMutationResult,
  SetPermissionModeResult,
  StatusPatch,
} from './types.ts';

const CLAIM_STATUSES = ['RUNNING', 'CANCELLING'] as const;

const WORKER_TRANSITIONS: Record<RunStatus, readonly RunStatus[]> = {
  QUEUED: [],
  RUNNING: ['WAITING_TOOL', 'WAITING_HUMAN', 'COMPLETED', 'STOPPED', 'FAILED', 'CANCELLING', 'QUEUED'],
  WAITING_TOOL: [],
  WAITING_HUMAN: [],
  CANCELLING: ['CANCELLED'],
  COMPLETED: [],
  STOPPED: [],
  FAILED: [],
  CANCELLED: [],
};

const SERVICE_TRANSITIONS: Record<RunStatus, readonly RunStatus[]> = {
  QUEUED: ['CANCELLED'],
  RUNNING: ['CANCELLING'],
  WAITING_TOOL: ['QUEUED', 'CANCELLING'],
  WAITING_HUMAN: ['QUEUED', 'CANCELLED', 'STOPPED'],
  CANCELLING: [],
  COMPLETED: [],
  STOPPED: [],
  FAILED: [],
  CANCELLED: [],
};

const SWEEP_TRANSITIONS: Record<RunStatus, readonly RunStatus[]> = {
  ...SERVICE_TRANSITIONS,
  QUEUED: ['STOPPED'],
};

const DEAD_LETTER_TRANSITIONS: Record<RunStatus, readonly RunStatus[]> = {
  QUEUED: ['FAILED', 'CANCELLED'],
  RUNNING: ['FAILED', 'CANCELLED'],
  WAITING_TOOL: [],
  WAITING_HUMAN: [],
  CANCELLING: ['CANCELLED'],
  COMPLETED: [],
  STOPPED: [],
  FAILED: [],
  CANCELLED: [],
};

const isClaimStatus = (status: RunStatus): status is ClaimStatus => CLAIM_STATUSES.some((claimStatus) => claimStatus === status);

const releaseTarget = (status: ClaimStatus): 'QUEUED' | 'CANCELLING' => {
  switch (status) {
    case 'RUNNING':
      return 'QUEUED';
    case 'CANCELLING':
      return 'CANCELLING';
    default: {
      const unreachable: never = status;
      throw new Error(`unhandled claim status ${String(unreachable)}`);
    }
  }
};

const refundedAttempts = (run: Run, refund: boolean | undefined): number => {
  if (refund !== true) return run.attempts;
  if (run.attempts <= 0) throw new Error(`run ${run.id} has no attempt to refund`);
  return run.attempts - 1;
};

const clearLease = (
  run: Run,
  change: { availableAt: number; resetFailures: boolean; refundAttempt: boolean | undefined },
): Pick<Run, 'leaseOwner' | 'leaseExpiresAt' | 'availableAt' | 'failedAttempts' | 'attempts'> => ({
  leaseOwner: null,
  leaseExpiresAt: null,
  availableAt: change.availableAt,
  failedAttempts: change.resetFailures ? 0 : run.failedAttempts,
  attempts: refundedAttempts(run, change.refundAttempt),
});

const isTerminal = (status: RunStatus): boolean => TERMINAL_STATUSES.some((terminal) => terminal === status);

const CLAIMABLE = `
  (
    (r.status = 'QUEUED' AND r.available_at <= :now)
    OR (r.status IN ('RUNNING', 'CANCELLING') AND r.available_at <= :now AND (r.lease_expires_at IS NULL OR r.lease_expires_at <= :now))
  )
  AND NOT EXISTS (
    SELECT 1 FROM runs earlier
    WHERE earlier.session_id = r.session_id
      AND earlier.ordinal < r.ordinal
      AND earlier.status NOT IN ('COMPLETED', 'STOPPED', 'FAILED', 'CANCELLED')
  )
`;

const TAKEOVER = "(r.status IN ('RUNNING', 'CANCELLING') AND r.lease_owner IS NOT NULL)";

const EXHAUSTED = `((${TAKEOVER} AND r.failed_attempts + 1 >= :maxAttempts) OR r.attempts + 1 > :maxTotalAttempts)`;

const CLAIM_ORDER = 'ORDER BY r.available_at, r.created_at, r.rowid';

const RUN_INSERT_SQL = `
  INSERT INTO runs (
    id, session_id, ordinal, idempotency_key, request_digest, previous_run_id, status, version, lease_token, available_at, attempts,
    failed_attempts, cancel_requested, deadline_at, limits_json, usage_json, step, last_seq, pins, dead_letter, created_at
  ) VALUES (
    :id, :sessionId, :ordinal, :idempotencyKey, :requestDigest, :previousRunId, 'QUEUED', 0, 0, :availableAt, 0,
    0, 0, :deadlineAt, :limits, :usage, 0, 0, :pins, 0, :createdAt
  )
`;

const RUN_WRITE_SQL = `
  UPDATE runs SET
    status = :status,
    stop_reason = :stopReason,
    version = :version,
    lease_owner = :leaseOwner,
    lease_token = :leaseToken,
    lease_expires_at = :leaseExpiresAt,
    available_at = :availableAt,
    attempts = :attempts,
    failed_attempts = :failedAttempts,
    cancel_requested = :cancelRequested,
    usage_json = :usage,
    step = :step,
    last_seq = :lastSeq,
    error_json = :error,
    dead_letter = :deadLetter
  WHERE id = :id
`;

const FENCE_SQL = `
  UPDATE runs SET version = version
  WHERE id = :runId AND lease_token = :leaseToken AND lease_owner = :workerId AND status IN ('RUNNING', 'CANCELLING')
  RETURNING *
`;

const prepareStatements = (db: DatabaseSync) => ({
  insertSession: db.prepare(
    `INSERT INTO sessions (id, cwd, env_json, permission_mode, model_alias, bypass_allowed, additional_directories_json, created_at)
     VALUES (:id, :cwd, :env, :permissionMode, :modelAlias, :bypassAllowed, :additionalDirectories, :createdAt)`,
  ),
  updateSessionMode: db.prepare('UPDATE sessions SET permission_mode = :permissionMode WHERE id = :id'),
  sessionMaxEventId: db.prepare('SELECT COALESCE(MAX(id), 0) AS max_id FROM events WHERE session_id = :sessionId'),
  selectSession: db.prepare('SELECT * FROM sessions WHERE id = :id'),
  listSessions: db.prepare('SELECT * FROM sessions ORDER BY created_at, rowid'),
  listSessionsByCwd: db.prepare('SELECT * FROM sessions WHERE cwd = :cwd ORDER BY created_at, rowid'),
  dataVersion: db.prepare('PRAGMA data_version'),
  selectRun: db.prepare('SELECT * FROM runs WHERE id = :id'),
  latestSessionEventTime: db.prepare('SELECT created_at FROM events WHERE session_id = :sessionId ORDER BY id DESC LIMIT 1'),
  activeRunExists: db.prepare(
    `SELECT EXISTS (SELECT 1 FROM runs WHERE session_id = :sessionId AND status NOT IN (${TERMINAL_STATUSES.map((status) => `'${status}'`).join(', ')})) AS active`,
  ),
  selectRunByKey: db.prepare('SELECT * FROM runs WHERE session_id = :sessionId AND idempotency_key = :key'),
  listRuns: db.prepare('SELECT * FROM runs WHERE session_id = :sessionId ORDER BY ordinal'),
  latestRunOfSession: db.prepare('SELECT id FROM runs WHERE session_id = :sessionId ORDER BY ordinal DESC LIMIT 1'),
  nextOrdinal: db.prepare('SELECT COALESCE(MAX(ordinal), 0) + 1 AS next FROM runs WHERE session_id = :sessionId'),
  insertRun: db.prepare(RUN_INSERT_SQL),
  writeRun: db.prepare(RUN_WRITE_SQL),
  insertEvent: db.prepare(
    `INSERT INTO events (run_id, session_id, seq, step, lease_token, created_at, type, payload_json)
     VALUES (:runId, :sessionId, :seq, :step, :leaseToken, :createdAt, :type, :payload)`,
  ),
  dueWaitingRuns: db.prepare(
    `SELECT r.id FROM runs r
     WHERE (r.status = 'QUEUED' AND r.deadline_at <= :nowMs)
       OR (
         r.status = 'WAITING_HUMAN'
         AND (
           r.deadline_at <= :nowMs
           OR EXISTS (SELECT 1 FROM approvals a WHERE a.run_id = r.id AND a.status = 'pending' AND a.expires_at <= :nowMs)
         )
       )
     ORDER BY r.created_at, r.rowid`,
  ),
  toolCallEvent: db.prepare(
    "SELECT payload_json FROM events WHERE run_id = :runId AND type = 'tool.call' AND json_extract(payload_json, '$.callId') = :callId LIMIT 1",
  ),
  requestedEvent: db.prepare(
    "SELECT payload_json FROM events WHERE run_id = :runId AND type = 'tool.permission.requested' AND json_extract(payload_json, '$.approvalId') = :approvalId LIMIT 1",
  ),
  runEvents: db.prepare('SELECT * FROM events WHERE run_id = :runId AND seq > :after ORDER BY seq LIMIT :limit'),
  sessionEvents: db.prepare('SELECT * FROM events WHERE session_id = :sessionId AND id > :after ORDER BY id LIMIT :limit'),
  selectExhausted: db.prepare(
    `SELECT r.* FROM runs r WHERE ${CLAIMABLE} AND ${EXHAUSTED} ${CLAIM_ORDER} LIMIT 1`,
  ),
  claim: db.prepare(
    `UPDATE runs SET
       status = CASE WHEN status = 'QUEUED' THEN 'RUNNING' ELSE status END,
       version = version + 1,
       lease_owner = :workerId,
       lease_token = lease_token + 1,
       lease_expires_at = :leaseExpiresAt,
       attempts = attempts + 1,
       failed_attempts = CASE
         WHEN status IN ('RUNNING', 'CANCELLING') AND lease_owner IS NOT NULL THEN failed_attempts + 1
         ELSE failed_attempts
       END
     WHERE id = (
       SELECT r.id FROM runs r WHERE ${CLAIMABLE} AND NOT ${EXHAUSTED} ${CLAIM_ORDER} LIMIT 1
     )
     RETURNING *`,
  ),
  heartbeat: db.prepare(
    `UPDATE runs SET lease_expires_at = :leaseExpiresAt
     WHERE id = :runId AND lease_token = :leaseToken AND lease_owner = :workerId AND status IN ('RUNNING', 'CANCELLING')
     RETURNING status, cancel_requested, id`,
  ),
  fence: db.prepare(FENCE_SQL),
  approvalRequested: db.prepare(
    "SELECT 1 AS present FROM events WHERE run_id = :runId AND type = 'tool.permission.requested' AND json_extract(payload_json, '$.approvalId') = :approvalId LIMIT 1",
  ),
  latestSnapshot: db.prepare('SELECT * FROM snapshots WHERE run_id = :runId ORDER BY seq DESC LIMIT 1'),
  upsertSnapshot: db.prepare(
    `INSERT INTO snapshots (run_id, seq, state_json, created_at) VALUES (:runId, :seq, :state, :createdAt)
     ON CONFLICT (run_id, seq) DO UPDATE SET state_json = excluded.state_json, created_at = excluded.created_at`,
  ),
  pruneSnapshots: db.prepare('DELETE FROM snapshots WHERE run_id = :runId AND seq < :seq'),
});

type Statements = ReturnType<typeof prepareStatements>;

type StatusChange = {
  edges: Record<RunStatus, readonly RunStatus[]>;
  availableAt?: number;
  patch?: StatusPatch;
  deadLetter?: boolean;
  resetFailures?: boolean;
  refundAttempt?: boolean;
};

const payloadStep = (payload: RunEventPayload): number => ('step' in payload ? payload.step : 0);

const assertPositiveInteger = (name: string, value: number): void => {
  if (!Number.isInteger(value) || value < 1) throw new RangeError(`openRuntimeStore: ${name} must be a positive integer, got ${value}`);
};

export const openRuntimeStore = (options: RuntimeStoreOptions): RuntimeStore => {
  assertPositiveInteger('leaseMs', options.leaseMs);
  assertPositiveInteger('maxAttempts', options.maxAttempts);
  assertPositiveInteger('maxTotalAttempts', options.maxTotalAttempts);
  if (options.maxTotalAttempts < options.maxAttempts) {
    throw new RangeError(
      `openRuntimeStore: maxTotalAttempts (${options.maxTotalAttempts}) must be at least maxAttempts (${options.maxAttempts})`,
    );
  }
  if (typeof options.home !== 'string') throw new TypeError('openRuntimeStore: home is required');
  const home = fs.realpathSync.native(options.home);
  const { clock, leaseMs, maxAttempts, maxTotalAttempts } = options;
  const db = openDatabase(options.path);
  let statements: Statements;
  let blobDirectory: string;
  let identity: fs.Stats;
  try {
    identity = fs.statSync(options.path);
    migrate(db, MIGRATIONS);
    blobDirectory = path.join(path.dirname(options.path), 'blobs');
    prepareBlobDirectory(blobDirectory);
    statements = prepareStatements(db);
  } catch (error) {
    db.close();
    throw error;
  }
  const sql = statements;
  const approvalOps = createApprovalStore(db, clock);
  const touched = new Map<string, { runId?: string; sessionId: string }>();

  const recordTouch = (sessionId: string, runId: string | null): void => {
    if (options.onCommit === undefined) return;
    touched.set(`${sessionId}\n${runId ?? ''}`, runId === null ? { sessionId } : { runId, sessionId });
  };

  const announceCommit = (): void => {
    const onCommit = options.onCommit;
    if (onCommit === undefined || touched.size === 0) return;
    const announced = [...touched.values()];
    touched.clear();
    queueMicrotask(() => onCommit(announced));
  };

  const transaction = <T>(fn: () => T): T => {
    try {
      const result = immediateTx(db, fn);
      announceCommit();
      return result;
    } catch (error) {
      touched.clear();
      throw error;
    }
  };

  const insertEvent = (event: {
    runId: string | null;
    sessionId: string;
    seq: number | null;
    step: number | null;
    leaseToken: number | null;
    createdAt: number;
    payload: RunEventPayload | SessionEventPayload;
  }): void => {
    sql.insertEvent.run({
      runId: event.runId,
      sessionId: event.sessionId,
      seq: event.seq,
      step: event.step,
      leaseToken: event.leaseToken,
      createdAt: event.createdAt,
      type: event.payload.type,
      payload: canonicalJson(event.payload),
    });
    recordTouch(event.sessionId, event.runId);
  };

  const approvalAnnounced = (runId: string, approvalId: string): boolean =>
    sql.requestedEvent.get({ runId, approvalId }) !== undefined;

  const requireRun = (runId: string): Run => {
    const row = sql.selectRun.get({ id: runId });
    if (row === undefined) throw new Error(`unknown run ${runId}`);
    return decodeRun(row);
  };

  const writeRun = (run: Run): void => {
    const result = sql.writeRun.run({
      id: run.id,
      status: run.status,
      stopReason: run.stopReason ?? null,
      version: run.version,
      leaseOwner: run.leaseOwner,
      leaseToken: run.leaseToken,
      leaseExpiresAt: run.leaseExpiresAt,
      availableAt: run.availableAt,
      attempts: run.attempts,
      failedAttempts: run.failedAttempts,
      cancelRequested: run.cancelRequested ? 1 : 0,
      usage: canonicalJson(run.usage),
      step: run.step,
      lastSeq: run.lastSeq,
      error: run.error === undefined ? null : canonicalJson(run.error),
      deadLetter: run.deadLetter ? 1 : 0,
    });
    if (Number(result.changes) !== 1) throw new Error(`run ${run.id} could not be written`);
  };

  const appendPayloads = (run: Run, payloads: readonly RunEventPayload[]): Run => {
    let current = run;
    const createdAt = clock.now();
    for (const payload of payloads) {
      const step = Math.max(current.step, payloadStep(payload));
      const seq = current.lastSeq + 1;
      insertEvent({ runId: run.id, sessionId: run.sessionId, seq, step, leaseToken: run.leaseToken, createdAt, payload });
      const usage =
        payload.type === 'model.responded'
          ? {
              inputTokens: current.usage.inputTokens + payload.response.usage.input_tokens,
              outputTokens: current.usage.outputTokens + payload.response.usage.output_tokens,
              totalTokens: current.usage.totalTokens + payload.response.usage.total_tokens,
            }
          : current.usage;
      current = { ...current, step, lastSeq: seq, usage };
    }
    return current;
  };

  const withdrawPendingApprovals = (runId: string): RunEventPayload[] =>
    approvalOps.store.listPending(runId).flatMap((approval): RunEventPayload[] => {
      approvalOps.end(approval.id, 'withdrawn');
      return approvalAnnounced(runId, approval.id) ? [{ type: 'tool.permission.cancelled', approvalId: approval.id, reason: 'withdrawn' }] : [];
    });

  const changeStatus = (run: Run, to: RunStatus, change: StatusChange, leadingEvents: readonly RunEventPayload[] = []): Run => {
    if (!change.edges[run.status].includes(to)) throw new Error(`run ${run.id} has no permitted edge ${run.status} -> ${to}`);
    const patch = change.patch ?? {};
    const reason = patch.stopReason ?? patch.error?.code;
    const statusEvent: RunEventPayload = { type: 'run.status', from: run.status, to, ...(reason === undefined ? {} : { reason }) };
    const withdrawal = isTerminal(to) || to === 'CANCELLING' ? withdrawPendingApprovals(run.id) : [];
    const appended = appendPayloads(run, [...leadingEvents, ...withdrawal, statusEvent]);
    const keepsLease = to === 'RUNNING' || to === 'CANCELLING';
    const wakesNow = to === 'QUEUED' || (to === 'CANCELLING' && run.leaseOwner === null);
    const availableAt = change.availableAt ?? (wakesNow ? clock.now() : run.availableAt);
    const next: Run = {
      ...appended,
      status: to,
      version: run.version + 1,
      cancelRequested: run.cancelRequested || to === 'CANCELLING' || to === 'CANCELLED',
      deadLetter: change.deadLetter ?? run.deadLetter,
      ...(keepsLease
        ? {
            leaseOwner: run.leaseOwner,
            leaseExpiresAt: run.leaseExpiresAt,
            availableAt,
            failedAttempts: change.resetFailures === true ? 0 : run.failedAttempts,
            attempts: refundedAttempts(run, change.refundAttempt),
          }
        : clearLease(run, { availableAt, resetFailures: change.resetFailures === true, refundAttempt: change.refundAttempt })),
    };
    if (patch.stopReason !== undefined) next.stopReason = patch.stopReason;
    if (patch.error !== undefined) next.error = patch.error;
    writeRun(next);
    return requireRun(run.id);
  };

  const deadLetter = (run: Run): void => {
    const overTotal = run.attempts + 1 > maxTotalAttempts;
    const error = overTotal
      ? { code: 'max_total_attempts', message: `run ${run.id} exceeded ${maxTotalAttempts} total attempts` }
      : { code: 'max_attempts', message: `run ${run.id} exceeded ${maxAttempts} consecutive failed attempts` };
    const cancelled = run.cancelRequested || run.status === 'CANCELLING';
    changeStatus(run, cancelled ? 'CANCELLED' : 'FAILED', {
      edges: DEAD_LETTER_TRANSITIONS,
      deadLetter: true,
      patch: { error },
    });
  };

  const fenced = (claim: Claim): Run | undefined => {
    const row = sql.fence.get({ runId: claim.runId, leaseToken: claim.leaseToken, workerId: claim.workerId });
    return row === undefined ? undefined : decodeRun(row);
  };

  const leaseLost: LeaseLost = { kind: 'lease_lost' };

  const conflict = (reason: string): Conflict => ({ kind: 'conflict', reason });

  const moveWorker = (
    run: Run,
    from: readonly RunStatus[],
    to: RunStatus,
    change: Omit<StatusChange, 'edges' | 'resetFailures'>,
  ): RunMutationResult => {
    if (!from.includes(run.status)) {
      return conflict(`run ${run.id} is ${run.status}, expected one of ${from.join(', ')}`);
    }
    if (!WORKER_TRANSITIONS[run.status].includes(to)) return conflict(`run ${run.id} cannot move from ${run.status} to ${to}`);
    return { kind: 'ok', run: changeStatus(run, to, { ...change, edges: WORKER_TRANSITIONS, resetFailures: true }) };
  };

  const workerTransition = (
    claim: Claim,
    from: readonly RunStatus[],
    to: RunStatus,
    change: Omit<StatusChange, 'edges' | 'resetFailures'>,
  ): RunMutationResult =>
    transaction<RunMutationResult>(() => {
      const run = fenced(claim);
      return run === undefined ? leaseLost : moveWorker(run, from, to, change);
    });

  const expireApproval = (runId: string, approval: Approval): RunEventPayload[] => {
    approvalOps.end(approval.id, 'expired');
    const notice: RunEventPayload = { type: 'notice', level: 'warning', message: `The approval for ${approval.callId} expired.` };
    return approvalAnnounced(runId, approval.id)
      ? [{ type: 'tool.permission.cancelled', approvalId: approval.id, reason: 'expired' }, notice]
      : [notice];
  };

  const stopWaitingRun = (run: Run, nowMs: number): boolean => {
    if (run.status === 'QUEUED' && run.deadlineAt <= nowMs) {
      changeStatus(run, 'STOPPED', { edges: SWEEP_TRANSITIONS, patch: { stopReason: 'timeout' } });
      return true;
    }
    if (run.status !== 'WAITING_HUMAN') return false;
    const due = approvalOps.listPendingDue(run.id, nowMs);
    if (due.length > 0) {
      const leading = due.flatMap((approval) => expireApproval(run.id, approval));
      changeStatus(run, 'STOPPED', { edges: SERVICE_TRANSITIONS, patch: { stopReason: 'approval_timeout' } }, leading);
      return true;
    }
    if (run.deadlineAt <= nowMs) {
      changeStatus(run, 'STOPPED', { edges: SERVICE_TRANSITIONS, patch: { stopReason: 'timeout' } });
      return true;
    }
    return false;
  };

  const resolveInTransaction = (approvalId: string, optionId: string): ResolveApprovalResult => {
    const approval = approvalOps.store.get(approvalId);
    if (approval === undefined) return { kind: 'not_found' };
    if (approval.status !== 'pending') return { kind: 'approval_not_pending', status: approval.status };
    if (!approvalAnnounced(approval.runId, approval.id)) return { kind: 'request_missing' };
    const now = clock.now();
    const run = requireRun(approval.runId);
    if (approval.expiresAt <= now) {
      stopWaitingRun(run, now);
      return { kind: 'approval_not_pending', status: 'expired' };
    }
    if (run.cancelRequested) return { kind: 'run_cancelled' };
    if (!approval.options.some((option) => option.optionId === optionId)) return { kind: 'option_not_offered' };
    const resolved = approvalOps.markResolved(approval.id, optionId);
    const event: RunEventPayload = { type: 'tool.permission.resolved', approvalId: approval.id, optionId };
    const settled = run.status === 'WAITING_HUMAN' && approvalOps.store.listPending(run.id).length === 0;
    if (settled) {
      changeStatus(run, 'QUEUED', { edges: SERVICE_TRANSITIONS, availableAt: now }, [event]);
    } else {
      writeRun({ ...appendPayloads(run, [event]), version: run.version + 1 });
    }
    return { kind: 'ok', approval: resolved, run: requireRun(run.id) };
  };

  const decodeLocations = (identity: string, value: unknown): { path: string; line?: number }[] => {
    if (!Array.isArray(value)) throw corrupt('events', identity, 'tool.call payload locations must be an array');
    return value.map((entry: unknown) => {
      if (!isRecord(entry) || typeof entry['path'] !== 'string' || (entry['line'] !== undefined && typeof entry['line'] !== 'number')) {
        throw corrupt('events', identity, 'tool.call payload holds a malformed location');
      }
      return { path: entry['path'], ...(entry['line'] === undefined ? {} : { line: entry['line'] }) };
    });
  };

  const toolCallOf = (approval: Approval): ApprovalView['toolCall'] => {
    const row = sql.toolCallEvent.get({ runId: approval.runId, callId: approval.callId });
    if (row === undefined) throw corrupt('approvals', approval.id, `run ${approval.runId} has no tool.call event for call ${approval.callId}`);
    const payload = expectRecord('events', approval.id, 'payload_json', readerFor('events', approval.id, row).json('payload_json'));
    const { name, title, kind, locations } = payload;
    if (typeof name !== 'string' || typeof title !== 'string' || typeof kind !== 'string') {
      throw corrupt('events', approval.id, 'tool.call payload must hold string name, title and kind');
    }
    return {
      callId: approval.callId,
      name,
      title,
      kind: expectOneOf('events', approval.id, 'kind', TOOL_KINDS, kind),
      rawInput: payload['rawInput'],
      ...(locations === undefined ? {} : { locations: decodeLocations(approval.id, locations) }),
    };
  };

  const suggestedRuleOf = (approval: Approval): string | undefined => {
    const row = sql.requestedEvent.get({ runId: approval.runId, approvalId: approval.id });
    if (row === undefined) return undefined;
    const payload = expectRecord('events', approval.id, 'payload_json', readerFor('events', approval.id, row).json('payload_json'));
    const rule = payload['suggestedRule'];
    if (rule !== undefined && typeof rule !== 'string') throw corrupt('events', approval.id, 'suggestedRule must be a string');
    return rule;
  };

  const viewOf = (approval: Approval): ApprovalView => {
    const suggestedRule = suggestedRuleOf(approval);
    return {
      id: approval.id,
      runId: approval.runId,
      callId: approval.callId,
      status: approval.status,
      options: approval.options,
      expiresAt: approval.expiresAt,
      createdAt: approval.createdAt,
      ...(suggestedRule === undefined ? {} : { suggestedRule }),
      toolCall: toolCallOf(approval),
    };
  };

  const findRunByIdempotencyKey = (sessionId: string, key: string): { run: Run; requestDigest: string | null } | undefined => {
    const row = sql.selectRunByKey.get({ sessionId, key });
    if (row === undefined) return undefined;
    return { run: decodeRun(row), requestDigest: readerFor('runs', String(row['id']), row).nullableString('request_digest') };
  };

  const store: RuntimeStore = {
    createSession: (input) =>
      transaction(() => {
        const id = uuidv7(clock);
        sql.insertSession.run({
          id,
          cwd: input.cwd,
          env: canonicalJson(input.env),
          permissionMode: input.permissionMode,
          modelAlias: input.modelAlias,
          bypassAllowed: input.bypassAllowed === true ? 1 : 0,
          additionalDirectories: canonicalJson(input.additionalDirectories ?? []),
          createdAt: clock.now(),
        });
        const row = sql.selectSession.get({ id });
        if (row === undefined) throw new Error(`session ${id} vanished during create`);
        return decodeSession(row);
      }),

    getSession: (id) => {
      const row = sql.selectSession.get({ id });
      return row === undefined ? undefined : decodeSession(row);
    },

    listSessions: (filter) =>
      (filter?.cwd === undefined ? sql.listSessions.all() : sql.listSessionsByCwd.all({ cwd: filter.cwd })).map(decodeSession),

    setPermissionMode: (sessionId, mode: PermissionMode) =>
      transaction<SetPermissionModeResult>(() => {
        const row = sql.selectSession.get({ id: sessionId });
        if (row === undefined) return { kind: 'not_found' };
        const session = decodeSession(row);
        if (session.permissionMode === mode) return { kind: 'ok', session, changed: false };
        sql.updateSessionMode.run({ id: sessionId, permissionMode: mode });
        insertEvent({ runId: null, sessionId, seq: null, step: null, leaseToken: null, createdAt: clock.now(), payload: { type: 'mode.changed', mode } });
        return { kind: 'ok', session: { ...session, permissionMode: mode }, changed: true };
      }),

    createRunAndEnqueue: (sessionId, input) =>
      transaction<CreateRunResult>(() => {
        if (sql.selectSession.get({ id: sessionId }) === undefined) return { kind: 'not_found' };
        if (input.idempotencyKey !== undefined) {
          const existing = findRunByIdempotencyKey(sessionId, input.idempotencyKey);
          if (existing !== undefined) {
            return sameRunRequest(existing, input.requestDigest) ? { kind: 'existing', run: existing.run } : { kind: 'key_reused' };
          }
        }
        const ordinalRow = sql.nextOrdinal.get({ sessionId });
        if (ordinalRow === undefined) throw new Error(`could not compute the next run ordinal for session ${sessionId}`);
        const ordinal = readerFor('runs', sessionId, ordinalRow).number('next');
        const previous = sql.latestRunOfSession.get({ sessionId });
        const id = uuidv7(clock);
        const now = clock.now();
        sql.insertRun.run({
          id,
          sessionId,
          ordinal,
          idempotencyKey: input.idempotencyKey ?? null,
          requestDigest: input.requestDigest ?? null,
          previousRunId: previous === undefined ? null : readerFor('runs', sessionId, previous).string('id'),
          availableAt: now,
          deadlineAt: now + input.timeoutMs,
          limits: canonicalJson(input.limits),
          usage: canonicalJson({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }),
          pins: canonicalJson(input.pins),
          createdAt: now,
        });
        const inserted = appendPayloads(requireRun(id), [{ type: 'user.message', text: input.input }]);
        writeRun(inserted);
        return { kind: 'created', run: requireRun(id) };
      }),

    findRunByIdempotencyKey,

    sessionActivity: (sessionId) =>
      readTx(db, () => {
        const row = sql.selectSession.get({ id: sessionId });
        if (row === undefined) return undefined;
        const latest = sql.latestSessionEventTime.get({ sessionId });
        const active = sql.activeRunExists.get({ sessionId });
        if (active === undefined) throw new Error(`could not compute whether session ${sessionId} has an active run`);
        return {
          lastActivityAt: latest === undefined ? decodeSession(row).createdAt : readerFor('events', sessionId, latest).number('created_at'),
          hasActiveRun: readerFor('runs', sessionId, active).number('active') === 1,
        };
      }),

    checkIdentity: () => {
      let current: fs.Stats;
      try {
        current = fs.statSync(options.path);
      } catch (error) {
        throw new StoreIdentityError(`database ${options.path} is no longer present`, { cause: error });
      }
      if (current.dev !== identity.dev || current.ino !== identity.ino) {
        throw new StoreIdentityError(`database ${options.path} was replaced: it is not the file this store opened`);
      }
    },

    listRuns: (sessionId, statuses) =>
      sql.listRuns
        .all({ sessionId })
        .map(decodeRun)
        .filter((run) => statuses === undefined || statuses.includes(run.status)),

    getRun: (id) => {
      const row = sql.selectRun.get({ id });
      return row === undefined ? undefined : decodeRun(row);
    },

    claim: (workerId) =>
      transaction(() => {
        const now = clock.now();
        for (;;) {
          const exhausted = sql.selectExhausted.get({ now, maxAttempts, maxTotalAttempts });
          if (exhausted === undefined) break;
          deadLetter(decodeRun(exhausted));
        }
        const row = sql.claim.get({ now, maxAttempts, maxTotalAttempts, workerId, leaseExpiresAt: now + leaseMs });
        if (row === undefined) return null;
        const run = decodeRun(row);
        const status: ClaimStatus = expectOneOf('runs', run.id, 'status', CLAIM_STATUSES, run.status);
        return { runId: run.id, sessionId: run.sessionId, workerId, leaseToken: run.leaseToken, attempt: run.attempts, status };
      }),

    heartbeat: (claim) =>
      transaction<HeartbeatResult>( () => {
        const row = sql.heartbeat.get({
          runId: claim.runId,
          leaseToken: claim.leaseToken,
          workerId: claim.workerId,
          leaseExpiresAt: clock.now() + leaseMs,
        });
        if (row === undefined) return leaseLost;
        const reader = readerFor('runs', claim.runId, row);
        return {
          kind: 'ok',
          cancelRequested: reader.flag('cancel_requested'),
          status: expectOneOf('runs', claim.runId, 'status', CLAIM_STATUSES, reader.string('status')),
        };
      }),

    append: (claim, events) =>
      transaction(() => {
        const run = fenced(claim);
        if (run === undefined) return leaseLost;
        if (events.length === 0) return { kind: 'ok', lastSeq: run.lastSeq } as const;
        const next = appendPayloads(run, events);
        writeRun(next);
        return { kind: 'ok', lastSeq: next.lastSeq } as const;
      }),

    transition: (claim, from, to, patch) => workerTransition(claim, from, to, patch === undefined ? {} : { patch }),

    release: (claim, to, availableAt, options) =>
      transaction<RunMutationResult>(() => {
        const run = fenced(claim);
        if (run === undefined) return leaseLost;
        const refund = options?.refundAttempt === true ? { refundAttempt: true } : {};
        if (to === 'WAITING_HUMAN' && approvalOps.store.listPending(run.id).length === 0) {
          return moveWorker(run, CLAIM_STATUSES, 'QUEUED', { availableAt: clock.now(), ...refund });
        }
        return moveWorker(run, CLAIM_STATUSES, to, { ...(availableAt === undefined ? {} : { availableAt }), ...refund });
      }),

    releaseLease: (claim, options) =>
      transaction<RunMutationResult>(() => {
        const run = fenced(claim);
        if (run === undefined) return leaseLost;
        const refund = options.refundAttempt === true ? { refundAttempt: true } : {};
        if (!isClaimStatus(run.status)) return conflict(`run ${run.id} is ${run.status}, expected one of ${CLAIM_STATUSES.join(', ')}`);
        if (releaseTarget(run.status) === 'QUEUED') return moveWorker(run, ['RUNNING'], 'QUEUED', { availableAt: options.availableAt, ...refund });
        writeRun({
          ...run,
          version: run.version + 1,
          ...clearLease(run, { availableAt: options.availableAt, resetFailures: true, refundAttempt: options.refundAttempt }),
        });
        return { kind: 'ok', run: requireRun(run.id) };
      }),

    requestCancel: (runId) =>
      transaction<RequestCancelResult>(() => {
        const row = sql.selectRun.get({ id: runId });
        if (row === undefined) return { kind: 'not_found' };
        const run = decodeRun(row);
        if (isTerminal(run.status) || run.status === 'CANCELLING') return { kind: 'ok', run, changed: false };
        const to: RunStatus = run.status === 'QUEUED' || run.status === 'WAITING_HUMAN' ? 'CANCELLED' : 'CANCELLING';
        if (!SERVICE_TRANSITIONS[run.status].includes(to)) throw new Error(`run ${runId} in status ${run.status} cannot be cancelled`);
        return { kind: 'ok', run: changeStatus(run, to, { edges: SERVICE_TRANSITIONS }), changed: true };
      }),

    appendAsService: (runId, expectedVersion, to, events, patch) =>
      transaction<ServiceMutationResult>( () => {
        const run = requireRun(runId);
        if (run.version !== expectedVersion) {
          return conflict(`run ${runId} is at version ${run.version}, expected ${expectedVersion}`);
        }
        if (isTerminal(run.status)) return conflict(`run ${runId} is ${run.status} and immutable`);
        if (to === null) {
          const appended = appendPayloads(run, events);
          writeRun({ ...appended, version: run.version + 1 });
          return { kind: 'ok', run: requireRun(runId) };
        }
        if (!SERVICE_TRANSITIONS[run.status].includes(to)) return conflict(`run ${runId} cannot move from ${run.status} to ${to}`);
        const change: StatusChange = { edges: SERVICE_TRANSITIONS, ...(patch === undefined ? {} : { patch }) };
        return { kind: 'ok', run: changeStatus(run, to, change, events) };
      }),

    readRunEvents: (runId, afterSeq, limit) => decodeRunEvents(sql.runEvents.all({ runId, after: afterSeq, limit })),

    readSessionEvents: (sessionId, afterId, limit) =>
      sql.sessionEvents.all({ sessionId, after: afterId, limit }).map(decodeEvent),

    sessionMaxEventId: (sessionId) => {
      const row = sql.sessionMaxEventId.get({ sessionId });
      if (row === undefined) throw new Error(`could not compute the maximum event id of session ${sessionId}`);
      return readerFor('events', sessionId, row).number('max_id');
    },

    load: (runId) =>
      readTx(db, (): LoadedRun => {
        requireRun(runId);
        const row: Row | undefined = sql.latestSnapshot.get({ runId });
        if (row === undefined) return { tail: decodeRunEvents(sql.runEvents.all({ runId, after: 0, limit: -1 })) };
        const identity = `${runId}@${String(row['seq'])}`;
        const reader = readerFor('snapshots', identity, row);
        const seq = reader.number('seq');
        const state = decodeRunState(identity, reader.json('state_json'));
        if (state === undefined) return { tail: decodeRunEvents(sql.runEvents.all({ runId, after: 0, limit: -1 })) };
        if (state.runId !== runId) throw corrupt('snapshots', identity, `state belongs to run ${state.runId}`);
        return { snapshot: { seq, state }, tail: decodeRunEvents(sql.runEvents.all({ runId, after: seq, limit: -1 })) };
      }),

    requestApproval: (claim, input) =>
      transaction<RequestApprovalResult>(() => {
        const run = fenced(claim);
        if (run === undefined) return leaseLost;
        const requested = approvalOps.request({
          runId: run.id,
          callId: input.callId,
          options: input.options,
          expiresAt: input.expiresAt,
          subjectDigest: input.event.subjectDigest,
        });
        const events: RunEventPayload[] = [];
        if (requested.superseded !== undefined && approvalAnnounced(run.id, requested.superseded.id)) {
          events.push({ type: 'tool.permission.cancelled', approvalId: requested.superseded.id, reason: 'superseded' });
        }
        if (requested.created || !approvalAnnounced(run.id, requested.approval.id)) {
          events.push({
            type: 'tool.permission.requested',
            approvalId: requested.approval.id,
            callId: input.callId,
            options: input.options,
            subjectDigest: input.event.subjectDigest,
            ...(input.event.suggestedRule === undefined ? {} : { suggestedRule: input.event.suggestedRule }),
          });
        }
        if (events.length > 0) writeRun(appendPayloads(run, events));
        return { kind: 'ok', approval: requested.approval };
      }),

    resolveApproval: (approvalId, optionId) => transaction<ResolveApprovalResult>(() => resolveInTransaction(approvalId, optionId)),

    expireApprovals: (nowMs) => {
      const stopped: string[] = [];
      for (const row of sql.dueWaitingRuns.all({ nowMs })) {
        const runId = readerFor('runs', 'due', row).string('id');
        const didStop = transaction(() => stopWaitingRun(requireRun(runId), nowMs));
        if (didStop) stopped.push(runId);
      }
      return stopped;
    },

    approvalView: (approvalId) => {
      const approval = approvalOps.store.get(approvalId);
      return approval === undefined ? undefined : viewOf(approval);
    },

    pendingApprovalViews: (runId) => approvalOps.store.listPending(runId).map(viewOf),

    writeSnapshot: (claim, seq, state) =>
      transaction(() => {
        const run = fenced(claim);
        if (run === undefined) return leaseLost;
        if (state.runId !== run.id) throw new Error(`snapshot state belongs to run ${state.runId}, not ${run.id}`);
        if (!Number.isInteger(seq) || seq < 0) throw new RangeError(`snapshot seq must be a non-negative integer, got ${seq}`);
        if (seq > run.lastSeq) return conflict(`snapshot seq ${seq} is beyond run ${run.id} last seq ${run.lastSeq}`);
        const latest = sql.latestSnapshot.get({ runId: run.id });
        if (latest !== undefined && readerFor('snapshots', run.id, latest).number('seq') > seq) {
          return conflict(`run ${run.id} already has a newer snapshot than seq ${seq}`);
        }
        sql.upsertSnapshot.run({ runId: run.id, seq, state: canonicalJson(encodeRunState(state)), createdAt: clock.now() });
        sql.pruneSnapshots.run({ runId: run.id, seq });
        return { kind: 'ok' } as const;
      }),

    idempotency: createIdempotencyStore(db, clock),
    approvals: approvalOps.store,
    blobs: createBlobStore(db, clock, blobDirectory),
    trust: createTrustStore(db, clock, home),

    dataVersion: () => {
      const row = sql.dataVersion.get();
      if (row === undefined) throw new Error('PRAGMA data_version returned no row');
      return readerFor('pragma', 'data_version', row).number('data_version');
    },

    close: () => {
      if (db.isOpen) db.close();
    },
  };
  return store;
};

