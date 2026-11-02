import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { canonicalJson, immediateTx, isTransientErrno, migrate, openDatabase, readTx, sha256Hex, uuidv7 } from '@momonga/foundation';
import { TERMINAL_STATUSES, TOOL_KINDS } from '@momonga/protocol';
import type { ElicitationAnswerRecord, ElicitationRequestView, PermissionMode, RunEventPayload, RunState, RunStatus, SessionEventPayload, TerminalStatus } from '@momonga/protocol';
import { createApprovalStore } from './approvals.ts';
import { createBlobStore, prepareBlobDirectory } from './blobs.ts';
import { foldRunState, initialRunState } from './fold.ts';
import { decodeEvent, decodeRun, decodeRunEvents, decodeRunState, decodeSession, encodeRunState } from './codec.ts';
import { StoreIdentityError, isFatalStoreError } from './fatal.ts';
import { createIdempotencyStore } from './idempotency.ts';
import { decodeJob, prepareJobStatements } from './jobs.ts';
import { createMemoryStore } from './memories.ts';
import { InheritanceError, applyInheritance, projectInheritance, retractsTask } from './inherit.ts';
import type { InheritanceOutcome, InheritedPayload } from './inherit.ts';
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
  CreateChildRunResult,
  CreateRunResult,
  ElicitationView,
  FinishJobResult,
  HeartbeatResult,
  InheritContextResult,
  JobStore,
  LeaseLost,
  LoadedRun,
  Run,
  RequestApprovalResult,
  RequestCancelResult,
  ResolveApprovalResult,
  ResolveElicitationResult,
  RunMutationResult,
  RuntimeStore,
  RuntimeStoreOptions,
  ServiceMutationResult,
  Session,
  SetPermissionModeResult,
  SetSessionMcpServersResult,
  StatusPatch,
  WaitTargets,
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

const isTerminal = (status: RunStatus): status is TerminalStatus => TERMINAL_STATUSES.some((terminal) => terminal === status);

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
    id, session_id, ordinal, idempotency_key, request_digest, previous_run_id, history_mode, parent_run_id, parent_call_id, status, version, lease_token,
    available_at, attempts, failed_attempts, cancel_requested, deadline_at, limits_json, usage_json, step, last_seq, pins, dead_letter, created_at
  ) VALUES (
    :id, :sessionId, :ordinal, :idempotencyKey, :requestDigest, :previousRunId, :historyMode, :parentRunId, :parentCallId, 'QUEUED', 0, 0,
    :availableAt, 0, 0, 0, :deadlineAt, :limits, :usage, 0, 0, :pins, 0, :createdAt
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

const TERMINAL_LIST = TERMINAL_STATUSES.map((status) => `'${status}'`).join(', ');

const ROOT_SESSION = 'NOT EXISTS (SELECT 1 FROM runs child WHERE child.session_id = s.id AND child.parent_run_id IS NOT NULL)';

const prepareStatements = (db: DatabaseSync) => ({
  insertSession: db.prepare(
    `INSERT INTO sessions (id, cwd, env_json, permission_mode, model_alias, bypass_allowed, additional_directories_json, mcp_servers_json, created_at)
     VALUES (:id, :cwd, :env, :permissionMode, :modelAlias, :bypassAllowed, :additionalDirectories, :mcpServers, :createdAt)`,
  ),
  updateSessionMcpServers: db.prepare('UPDATE sessions SET mcp_servers_json = :mcpServers WHERE id = :id'),
  updateSessionMode: db.prepare('UPDATE sessions SET permission_mode = :permissionMode WHERE id = :id'),
  sessionMaxEventId: db.prepare('SELECT COALESCE(MAX(id), 0) AS max_id FROM events WHERE session_id = :sessionId'),
  selectSession: db.prepare('SELECT * FROM sessions WHERE id = :id'),
  listSessions: db.prepare(`SELECT * FROM sessions s WHERE ${ROOT_SESSION} ORDER BY created_at, rowid`),
  listSessionsByCwd: db.prepare(`SELECT * FROM sessions s WHERE cwd = :cwd AND ${ROOT_SESSION} ORDER BY created_at, rowid`),
  childRuns: db.prepare('SELECT * FROM runs WHERE parent_run_id = :runId ORDER BY created_at, rowid'),
  childByCall: db.prepare('SELECT * FROM runs WHERE parent_run_id = :parentRunId AND parent_call_id = :parentCallId'),
  parentSessionOf: db.prepare(
    'SELECT p.session_id AS parent_session_id FROM runs c JOIN runs p ON p.id = c.parent_run_id WHERE c.session_id = :sessionId AND c.parent_run_id IS NOT NULL LIMIT 1',
  ),
  descendantSessionRuns: db.prepare(
    `WITH RECURSIVE tree(id) AS (SELECT id FROM runs WHERE session_id = :sessionId UNION SELECT c.id FROM runs c JOIN tree t ON c.parent_run_id = t.id)
     SELECT r.session_id AS session_id FROM runs r JOIN tree t ON r.id = t.id WHERE r.session_id <> :sessionId AND r.status NOT IN (${TERMINAL_LIST})`,
  ),
  treeTokens: db.prepare(
    `WITH RECURSIVE tree(id) AS (SELECT :rootId UNION ALL SELECT r.id FROM runs r JOIN tree t ON r.parent_run_id = t.id)
     SELECT COALESCE(SUM(json_extract(r.usage_json, '$.totalTokens')), 0) AS total FROM runs r JOIN tree t ON r.id = t.id`,
  ),
  waitingInSessionTree: db.prepare(
    `WITH RECURSIVE tree(session_id) AS (
       SELECT :rootSessionId
       UNION
       SELECT c.session_id FROM runs c JOIN runs p ON c.parent_run_id = p.id JOIN tree t ON p.session_id = t.session_id
     )
     SELECT r.id FROM runs r WHERE r.status = 'WAITING_TOOL' AND r.session_id IN (SELECT session_id FROM tree) ORDER BY r.created_at, r.rowid`,
  ),
  activeRunsOfSession: db.prepare(`SELECT id FROM runs WHERE session_id = :sessionId AND status NOT IN (${TERMINAL_LIST}) ORDER BY ordinal`),
  jobs: prepareJobStatements(db),
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
       OR (r.status = 'WAITING_TOOL' AND r.available_at <= :nowMs)
     ORDER BY r.created_at, r.rowid`,
  ),
  toolCallEvent: db.prepare(
    "SELECT payload_json FROM events WHERE run_id = :runId AND type = 'tool.call' AND json_extract(payload_json, '$.callId') = :callId LIMIT 1",
  ),
  requestedEvent: db.prepare(
    "SELECT payload_json FROM events WHERE run_id = :runId AND type = 'tool.permission.requested' AND json_extract(payload_json, '$.approvalId') = :approvalId LIMIT 1",
  ),
  elicitationRequestedEvent: db.prepare(
    "SELECT 1 AS present FROM events WHERE run_id = :runId AND type = 'tool.elicitation.requested' AND json_extract(payload_json, '$.inputId') = :approvalId LIMIT 1",
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
  inheritedEvent: db.prepare("SELECT 1 AS present FROM events WHERE run_id = :runId AND type = 'context.inherited' LIMIT 1"),
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
    sql.requestedEvent.get({ runId, approvalId }) !== undefined || sql.elicitationRequestedEvent.get({ runId, approvalId }) !== undefined;

  const cancelledEvent = (approval: Approval, reason: 'expired' | 'withdrawn' | 'superseded'): RunEventPayload =>
    approval.kind === 'elicitation'
      ? { type: 'tool.elicitation.cancelled', inputId: approval.id, reason }
      : { type: 'tool.permission.cancelled', approvalId: approval.id, reason };

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
      return approvalAnnounced(runId, approval.id) ? [cancelledEvent(approval, 'withdrawn')] : [];
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
    if (isTerminal(to) || to === 'CANCELLING') cancelChildren(run.id);
    if (isTerminal(to)) wakeParent(run);
    return requireRun(run.id);
  };

  const cancelTargetOf = (status: RunStatus): RunStatus => (status === 'QUEUED' || status === 'WAITING_HUMAN' ? 'CANCELLED' : 'CANCELLING');

  const cancelChildren = (runId: string): void => {
    for (const row of sql.childRuns.all({ runId })) {
      const child = decodeRun(row);
      if (isTerminal(child.status) || child.status === 'CANCELLING') continue;
      changeStatus(child, cancelTargetOf(child.status), { edges: SERVICE_TRANSITIONS });
    }
  };

  const wakeRun = (runId: string): void => {
    const run = requireRun(runId);
    if (run.status !== 'WAITING_TOOL') return;
    changeStatus(run, 'QUEUED', { edges: SERVICE_TRANSITIONS, availableAt: clock.now() });
  };

  const wakeParent = (child: Run): void => {
    if (child.parentRunId !== null) wakeRun(child.parentRunId);
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
    const notice: RunEventPayload = {
      type: 'notice',
      level: 'warning',
      message: `The ${approval.kind === 'elicitation' ? 'request for input' : 'approval'} for ${approval.callId} expired.`,
    };
    return approvalAnnounced(runId, approval.id)
      ? [cancelledEvent(approval, 'expired'), notice]
      : [notice];
  };

  const stopWaitingRun = (run: Run, nowMs: number): boolean => {
    if (run.status === 'QUEUED' && run.deadlineAt <= nowMs) {
      changeStatus(run, 'STOPPED', { edges: SWEEP_TRANSITIONS, patch: { stopReason: 'timeout' } });
      return true;
    }
    if (run.status === 'WAITING_TOOL') {
      if (run.availableAt > nowMs) return false;
      changeStatus(run, 'QUEUED', { edges: SERVICE_TRANSITIONS, availableAt: nowMs });
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
    if (approval === undefined || approval.kind !== 'permission') return { kind: 'not_found' };
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

  const resolveElicitationInTransaction = (elicitationId: string, responses: Record<string, ElicitationAnswerRecord>): ResolveElicitationResult => {
    const approval = approvalOps.store.get(elicitationId);
    if (approval === undefined) return { kind: 'not_found' };
    if (approval.kind !== 'elicitation') return { kind: 'wrong_kind' };
    if (approval.status !== 'pending') return { kind: 'approval_not_pending', status: approval.status };
    if (!approvalAnnounced(approval.runId, approval.id)) return { kind: 'request_missing' };
    const now = clock.now();
    const run = requireRun(approval.runId);
    if (approval.expiresAt <= now) {
      stopWaitingRun(run, now);
      return { kind: 'approval_not_pending', status: 'expired' };
    }
    if (run.cancelRequested) return { kind: 'run_cancelled' };
    const answered = approvalOps.markAnswered(approval.id, responses);
    const event: RunEventPayload = { type: 'tool.elicitation.resolved', inputId: approval.id, responses };
    const settled = run.status === 'WAITING_HUMAN' && approvalOps.store.listPending(run.id).length === 0;
    if (settled) {
      changeStatus(run, 'QUEUED', { edges: SERVICE_TRANSITIONS, availableAt: now }, [event]);
    } else {
      writeRun({ ...appendPayloads(run, [event]), version: run.version + 1 });
    }
    return { kind: 'ok', elicitation: answered, run: requireRun(run.id) };
  };

  const elicitationViewOf = (approval: Approval): ElicitationView => {
    if (approval.server === undefined || approval.requests === undefined) {
      throw corrupt('approvals', approval.id, 'an elicitation approval must carry its server and requests');
    }
    const { callId, name, title } = toolCallOf(approval);
    return {
      id: approval.id,
      runId: approval.runId,
      callId: approval.callId,
      status: approval.status,
      server: approval.server,
      requests: approval.requests,
      expiresAt: approval.expiresAt,
      createdAt: approval.createdAt,
      toolCall: { callId, name, title },
    };
  };

  const findRunByIdempotencyKey = (sessionId: string, key: string): { run: Run; requestDigest: string | null } | undefined => {
    const row = sql.selectRunByKey.get({ sessionId, key });
    if (row === undefined) return undefined;
    return { run: decodeRun(row), requestDigest: readerFor('runs', String(row['id']), row).nullableString('request_digest') };
  };

  const hasInheritedEvent = (runId: string): boolean => sql.inheritedEvent.get({ runId }) !== undefined;

  const loadInReadTx = (runId: string): LoadedRun => {
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
  };

  const foldedRun = (run: Run): RunState => {
    const loaded = loadInReadTx(run.id);
    return loaded.tail.reduce(foldRunState, loaded.snapshot?.state ?? initialRunState({ runId: run.id, sessionId: run.sessionId }));
  };

  const outcomeOf = (run: Run & { status: TerminalStatus }): InheritanceOutcome => ({
    status: run.status,
    ...(run.stopReason === undefined ? {} : { stopReason: run.stopReason }),
    ...(run.error === undefined ? {} : { errorCode: run.error.code }),
  });

  const predecessorOf = (child: Run): Run => {
    if (child.previousRunId === null) throw new InheritanceError('previous_run_inconsistent', `run ${child.id} has no previous run`);
    const row = sql.selectRun.get({ id: child.previousRunId });
    if (row === undefined) throw new InheritanceError('previous_run_inconsistent', `previous run ${child.previousRunId} of run ${child.id} does not exist`);
    const previous = decodeRun(row);
    if (previous.sessionId !== child.sessionId || previous.ordinal !== child.ordinal - 1) {
      throw new InheritanceError('previous_run_inconsistent', `previous run ${previous.id} is not the run before ${child.id} in session ${child.sessionId}`);
    }
    return previous;
  };

  type WalkedRun = { runId: string; lastSeq: number; status: RunStatus };
  type InheritPlan = { kind: 'none' } | { kind: 'already' } | Conflict | { kind: 'ready'; payload: InheritedPayload; walked: WalkedRun[] };

  type TerminalRun = Run & { status: TerminalStatus };

  const isTerminalRun = (run: Run): run is TerminalRun => isTerminal(run.status);

  const resolveSource = (run: Run, mode: PermissionMode): InheritPlan => {
    const walked: WalkedRun[] = [];
    const unmaterialised: TerminalRun[] = [];
    let base: TerminalRun;
    for (let cursor = run; ; ) {
      const previous = predecessorOf(cursor);
      if (!isTerminalRun(previous)) return conflict(`previous run ${previous.id} of run ${run.id} is ${previous.status}, not terminal`);
      walked.push({ runId: previous.id, lastSeq: previous.lastSeq, status: previous.status });
      if (previous.history === 'fresh' || previous.previousRunId === null || hasInheritedEvent(previous.id)) {
        base = previous;
        break;
      }
      unmaterialised.push(previous);
      cursor = previous;
    }
    let sourceRun = base;
    let sourceState = foldedRun(base);
    for (const candidate of unmaterialised.reverse()) {
      const candidateState = foldedRun(candidate);
      if (retractsTask(candidateState, outcomeOf(candidate))) continue;
      const payload = projectInheritance(sourceState, outcomeOf(sourceRun), { kind: 'intermediate' });
      sourceState = applyInheritance(candidateState, payload);
      sourceRun = candidate;
    }
    return { kind: 'ready', payload: projectInheritance(sourceState, outcomeOf(sourceRun), { kind: 'final', currentMode: mode }), walked };
  };

  const planInheritance = (claim: Claim, mode: PermissionMode): InheritPlan => {
    const run = requireRun(claim.runId);
    if (run.history !== 'inherit' || run.previousRunId === null) return { kind: 'none' };
    if (hasInheritedEvent(run.id)) return { kind: 'already' };
    try {
      return resolveSource(run, mode);
    } catch (error) {
      if (error instanceof InheritanceError || isFatalStoreError(error)) throw error;
      throw new InheritanceError('previous_run_unreadable', `the previous run of ${run.id} could not be read`, { cause: error });
    }
  };

  const writeInheritance = (claim: Claim, plan: Extract<InheritPlan, { kind: 'ready' }>): InheritContextResult =>
    transaction<InheritContextResult>(() => {
      const run = fenced(claim);
      if (run === undefined) return leaseLost;
      if (hasInheritedEvent(run.id)) return { kind: 'already' };
      for (const walkedRun of plan.walked) {
        const row = sql.selectRun.get({ id: walkedRun.runId });
        const current = row === undefined ? undefined : decodeRun(row);
        if (current === undefined || current.status !== walkedRun.status || current.lastSeq !== walkedRun.lastSeq) {
          return conflict(`run ${walkedRun.runId} changed while the context of run ${run.id} was being inherited`);
        }
      }
      writeRun(appendPayloads(run, [plan.payload]));
      return { kind: 'inherited' };
    });

  const requireSession = (sessionId: string): Session => {
    const row = sql.selectSession.get({ id: sessionId });
    if (row === undefined) throw new Error(`unknown session ${sessionId}`);
    return decodeSession(row);
  };

  const rootSessionIdOf = (sessionId: string): string => {
    let current = sessionId;
    for (;;) {
      const row = sql.parentSessionOf.get({ sessionId: current });
      if (row === undefined) return current;
      current = readerFor('runs', current, row).string('parent_session_id');
    }
  };

  const rootRunIdOf = (runId: string): string => {
    let current = requireRun(runId);
    while (current.parentRunId !== null) current = requireRun(current.parentRunId);
    return current.id;
  };

  const awaitsSettled = (targets: WaitTargets): boolean =>
    targets.runIds.some((runId) => isTerminal(requireRun(runId).status)) ||
    targets.jobIds.some((jobId) => {
      const row = sql.jobs.select.get({ id: jobId });
      if (row === undefined) throw new Error(`unknown job ${jobId}`);
      return decodeJob(row).status !== 'running';
    });

  const propagateMode = (sessionId: string, mode: PermissionMode): void => {
    const reached = new Set<string>();
    for (const row of sql.descendantSessionRuns.all({ sessionId })) reached.add(readerFor('runs', sessionId, row).string('session_id'));
    for (const reachedId of reached) {
      if (requireSession(reachedId).permissionMode === mode) continue;
      sql.updateSessionMode.run({ id: reachedId, permissionMode: mode });
      insertEvent({ runId: null, sessionId: reachedId, seq: null, step: null, leaseToken: null, createdAt: clock.now(), payload: { type: 'mode.changed', mode } });
    }
  };

  const jobs: JobStore = {
    start: (input) =>
      transaction(() => {
        const existing = sql.jobs.selectByKey.get({ idemKey: input.idemKey });
        if (existing !== undefined) return { job: decodeJob(existing), created: false };
        sql.jobs.insert.run({ ...input, sessionId: rootSessionIdOf(input.sessionId), startedAt: clock.now() });
        const row = sql.jobs.select.get({ id: input.id });
        if (row === undefined) throw new Error(`job ${input.id} vanished during start`);
        return { job: decodeJob(row), created: true };
      }),
    attachProcess: (id, pgid) => {
      if (Number(sql.jobs.attach.run({ id, pgid }).changes) !== 1) throw new Error(`cannot attach a process to job ${id}: it is not running`);
    },
    get: (id) => {
      const row = sql.jobs.select.get({ id });
      return row === undefined ? undefined : decodeJob(row);
    },
    byIdemKey: (idemKey) => {
      const row = sql.jobs.selectByKey.get({ idemKey });
      return row === undefined ? undefined : decodeJob(row);
    },
    listRunning: () => sql.jobs.running.all().map(decodeJob),
    listForSession: (sessionId) => sql.jobs.forSession.all({ sessionId: rootSessionIdOf(sessionId) }).map(decodeJob),
    finish: (id, result) =>
      transaction<FinishJobResult>(() => {
        const row = sql.jobs.select.get({ id });
        if (row === undefined) return { kind: 'not_found' };
        const job = decodeJob(row);
        if (job.status !== 'running') return { kind: 'already_finished', job };
        sql.jobs.finish.run({
          id,
          status: result.status,
          exitCode: result.exitCode ?? null,
          signal: result.signal ?? null,
          outputHandle: result.output?.handle ?? null,
          outputStart: result.output?.start ?? 0,
          outputTotal: result.output?.total ?? 0,
          endedAt: clock.now(),
        });
        const event: RunEventPayload = {
          type: 'job.finished',
          jobId: id,
          status: result.status,
          ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
          ...(result.signal === undefined ? {} : { signal: result.signal }),
        };
        for (const active of sql.activeRunsOfSession.all({ sessionId: job.sessionId })) {
          const run = requireRun(readerFor('runs', job.sessionId, active).string('id'));
          writeRun({ ...appendPayloads(run, [event]), version: run.version + 1 });
        }
        for (const waiting of sql.waitingInSessionTree.all({ rootSessionId: job.sessionId })) {
          wakeRun(readerFor('runs', job.sessionId, waiting).string('id'));
        }
        const finished = sql.jobs.select.get({ id });
        if (finished === undefined) throw new Error(`job ${id} vanished during finish`);
        return { kind: 'finished', job: decodeJob(finished) };
      }),
    advanceRead: (id, offset) => {
      sql.jobs.advance.run({ id, offset });
    },
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
          mcpServers: canonicalJson(input.mcpServers ?? {}),
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
        propagateMode(sessionId, mode);
        insertEvent({ runId: null, sessionId, seq: null, step: null, leaseToken: null, createdAt: clock.now(), payload: { type: 'mode.changed', mode } });
        return { kind: 'ok', session: { ...session, permissionMode: mode }, changed: true };
      }),

    setSessionMcpServers: (sessionId, servers) =>
      transaction<SetSessionMcpServersResult>(() => {
        const row = sql.selectSession.get({ id: sessionId });
        if (row === undefined) return { kind: 'not_found' };
        sql.updateSessionMcpServers.run({ id: sessionId, mcpServers: canonicalJson(servers) });
        return { kind: 'ok', session: { ...decodeSession(row), mcpServers: servers } };
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
          historyMode: input.history ?? 'inherit',
          parentRunId: null,
          parentCallId: null,
          availableAt: now,
          deadlineAt: now + input.timeoutMs,
          limits: canonicalJson(input.limits),
          usage: canonicalJson({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }),
          pins: canonicalJson(input.pins),
          createdAt: now,
        });
        const inserted = appendPayloads(requireRun(id), [
          { type: 'user.message', text: input.input, ...(input.images === undefined ? {} : { images: input.images }) },
          ...(input.skill === undefined ? [] : [{ type: 'skill.activated' as const, name: input.skill.name, content: input.skill.content }]),
        ]);
        writeRun(inserted);
        return { kind: 'created', run: requireRun(id) };
      }),

    createChildRun: (input) =>
      transaction<CreateChildRunResult>(() => {
        const existing = sql.childByCall.get({ parentRunId: input.parentRunId, parentCallId: input.parentCallId });
        if (existing !== undefined) {
          const run = decodeRun(existing);
          return { kind: 'existing', run, session: requireSession(run.sessionId) };
        }
        const parentRow = sql.selectRun.get({ id: input.parentRunId });
        if (parentRow === undefined) return { kind: 'parent_not_active', status: 'missing' };
        const parent = decodeRun(parentRow);
        if (isTerminal(parent.status) || parent.status === 'CANCELLING' || parent.cancelRequested) {
          return { kind: 'parent_not_active', status: parent.status };
        }
        const parentSession = requireSession(parent.sessionId);
        const now = clock.now();
        const sessionId = uuidv7(clock);
        sql.insertSession.run({
          id: sessionId,
          cwd: parentSession.cwd,
          env: canonicalJson(parentSession.env),
          permissionMode: parentSession.permissionMode,
          modelAlias: input.modelAlias ?? parentSession.modelAlias,
          bypassAllowed: parentSession.bypassAllowed ? 1 : 0,
          additionalDirectories: canonicalJson(parentSession.additionalDirectories),
          createdAt: now,
        });
        const runId = uuidv7(clock);
        sql.insertRun.run({
          id: runId,
          sessionId,
          ordinal: 1,
          idempotencyKey: null,
          requestDigest: null,
          previousRunId: null,
          historyMode: 'fresh',
          parentRunId: parent.id,
          parentCallId: input.parentCallId,
          availableAt: now,
          deadlineAt: parent.deadlineAt,
          limits: canonicalJson(parent.limits),
          usage: canonicalJson({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }),
          pins: canonicalJson(input.pins),
          createdAt: now,
        });
        writeRun(appendPayloads(requireRun(runId), [{ type: 'user.message', text: input.input }]));
        return { kind: 'created', run: requireRun(runId), session: requireSession(sessionId) };
      }),

    listChildRuns: (runId) => sql.childRuns.all({ runId }).map(decodeRun),

    treeTokens: (runId) => {
      const row = sql.treeTokens.get({ rootId: rootRunIdOf(runId) });
      if (row === undefined) throw new Error(`could not compute the token usage of the run tree of ${runId}`);
      return readerFor('runs', runId, row).number('total');
    },

    rootSessionId: rootSessionIdOf,

    jobs,

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
        if (isTransientErrno(error)) throw error;
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
        if (to === 'WAITING_TOOL' && options?.awaits !== undefined && awaitsSettled(options.awaits)) {
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
        const to = cancelTargetOf(run.status);
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

    load: (runId) => readTx(db, () => loadInReadTx(runId)),

    inheritContext: (claim, { mode }) => {
      const plan = readTx(db, () => planInheritance(claim, mode));
      return plan.kind === 'ready' ? writeInheritance(claim, plan) : plan;
    },

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
          events.push(cancelledEvent(requested.superseded, 'superseded'));
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

    requestElicitation: (claim, input) =>
      transaction<RequestApprovalResult>(() => {
        const run = fenced(claim);
        if (run === undefined) return leaseLost;
        const requested = approvalOps.request({
          runId: run.id,
          callId: input.callId,
          options: [],
          expiresAt: input.expiresAt,
          subjectDigest: sha256Hex(canonicalJson({ server: input.server, requests: input.requests })),
          elicitation: { server: input.server, requests: input.requests },
        });
        const events: RunEventPayload[] = [];
        if (requested.superseded !== undefined && approvalAnnounced(run.id, requested.superseded.id)) {
          events.push(cancelledEvent(requested.superseded, 'superseded'));
        }
        if (requested.created || !approvalAnnounced(run.id, requested.approval.id)) {
          events.push({ type: 'tool.elicitation.requested', inputId: requested.approval.id, callId: input.callId, server: input.server, requests: input.requests });
        }
        if (events.length > 0) writeRun(appendPayloads(run, events));
        return { kind: 'ok', approval: requested.approval };
      }),

    resolveElicitation: (elicitationId, responses) => transaction<ResolveElicitationResult>(() => resolveElicitationInTransaction(elicitationId, responses)),

    elicitationView: (elicitationId) => {
      const approval = approvalOps.store.get(elicitationId);
      return approval === undefined || approval.kind !== 'elicitation' ? undefined : elicitationViewOf(approval);
    },

    pendingElicitationViews: (runId) => approvalOps.store.listPending(runId).filter((approval) => approval.kind === 'elicitation').map(elicitationViewOf),

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
      return approval === undefined || approval.kind !== 'permission' ? undefined : viewOf(approval);
    },

    pendingApprovalViews: (runId) => approvalOps.store.listPending(runId).filter((approval) => approval.kind === 'permission').map(viewOf),

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
    memories: createMemoryStore(db, clock),

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

