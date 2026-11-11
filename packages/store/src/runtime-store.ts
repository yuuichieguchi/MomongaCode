import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { canonicalJson, immediateTx, isTransientErrno, migrate, openDatabase, openDatabaseWithIdentity, readTx, sha256Hex, uuidv7 } from '@momonga/foundation';
import type { DatabaseFileIdentity } from '@momonga/foundation';
import { FIDELITY_FOLD_VERSION, INBOX_MAX_PENDING, MEMORY_ORIGINS, PERMISSION_MODES, RUN_STATUSES, STOP_REASONS, TERMINAL_STATUSES, TOOL_KINDS, admitRequest, unknownEffectLines, unknownEffectOptions } from '@momonga/protocol';
import type { Admission, CallTiming, MemoryOrigin, ElicitationAnswerRecord, ElicitationRequestView, InboxDelivery, OpaqueEvent, PermissionMode, RunEvent, SessionEvent, TokenAnatomy, RunTracePrefix, RunEventPayload, RunState, TreeSpend, RunStatus, SessionEventPayload, TerminalStatus, UserShellRecord } from '@momonga/protocol';
import { createAppendRecords, columnsOf } from './append-records.ts';
import { createVerdictWriter } from './fidelity-verdicts.ts';
import { createApprovalStore } from './approvals.ts';
import { blobDirectoryOf, createBlobStore } from './blobs.ts';
import { addUsage, foldRunState, initialRunState, spendOf } from './fold.ts';
import { HISTORY_MODES, decodeContextOf, decodeKnownEvent, decodeRun, decodeRunEvents, decodeRunState, decodeSession, decodeStoredEvent, encodeRunState, userShellRecordOf } from './codec.ts';
import { createDerivedReads, createDerivedRepair } from './derived-repair.ts';
import type { DerivedScope } from './derived-repair.ts';
import { JournalThreadError, StalePreparation } from './journal-port.ts';
import { createJournalReader, payloadStep } from './journal-reader.ts';
import { StoreIdentityError, isFatalStoreError } from './fatal.ts';
import { createIdempotencyStore } from './idempotency.ts';
import { decodeJob, prepareJobStatements } from './jobs.ts';
import { createGoverningFactStore } from './governing.ts';
import { createGuidelineStore } from './guidelines.ts';
import { createContextChargeStore } from './context-charges.ts';
import { createMemoryStore } from './memories.ts';
import { createReflectionStore } from './reflection.ts';
import { referencePayload } from './inherit.ts';
import type { InheritPlanReply } from './inherit-reference.ts';
import { UNKNOWN_VALUE, corrupt, expectOneOf, expectRecord, isRecord, readerFor, refuseUnknown } from './rows.ts';
import type { Row, Stored } from './rows.ts';
import { sameRunRequest } from './run-request.ts';
import { MIGRATIONS } from './schema.ts';
import { CANCEL_ORIGINS, CLAIM_STATUSES, DEAD_LETTER_TRANSITIONS, SERVICE_TRANSITIONS, SWEEP_TRANSITIONS, WORKER_TRANSITIONS } from './transitions.ts';
import { createPermissionReviewsStore } from './permission-reviews.ts';
import { createRunFactsStore } from './run-facts.ts';
import { createSearchStore } from './search.ts';
import { createTrustStore } from './trust.ts';
import { createRuleVerdictStore } from './rule-verdicts.ts';
import { createInboxTable, inboxRowView } from './inbox.ts';
import type {
  Approval,
  ApprovalView,
  Claim,
  ClaimStatus,
  Conflict,
  CancelOrigin,
  ContributionMeasured,
  ContributionPreparer,
  CreateChildRunResult,
  CreateRunInput,
  CreateRunResult,
  InboxAddResult,
  InboxDeliverResult,
  InboxRow,
  InboxStore,
  UserShellStore,
  InboxWithdrawResult,
  QueuedRunTerms,
  ElicitationView,
  FinishJobResult,
  HeartbeatResult,
  ModelCallRecord,
  InheritContextResult,
  JobStore,
  LeaseFence,
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
  SetModelResult,
  SetPermissionModeResult,
  SetSessionMcpServersResult,
  StatusPatch,
  SweepErrorSink,
  WaitTargets,
} from './types.ts';

const journalPreparer = (preparer: ContributionPreparer | undefined, what: string): ContributionPreparer => {
  if (preparer === undefined) throw new JournalThreadError(`the ${what} of a run is read by the journal thread, and this store has none`);
  return preparer;
};

const isClaimStatus = (status: Stored<RunStatus>): status is ClaimStatus => CLAIM_STATUSES.some((claimStatus) => claimStatus === status);

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

const isTerminal = (status: Stored<RunStatus>): status is TerminalStatus => TERMINAL_STATUSES.some((terminal) => terminal === status);

const listed = (statuses: readonly RunStatus[], status: Stored<RunStatus>): boolean => statuses.some((candidate) => candidate === status);

const knownStatusOf = (run: Run): RunStatus => {
  if (run.status === UNKNOWN_VALUE) throw new Error(`run ${run.id} has a status this build does not know, so it is not acted on`);
  return run.status;
};

const sqlList = (values: readonly string[]): string => values.map((value) => `'${value}'`).join(', ');

const KNOWN_RUN_VALUES = `
  r.history_mode IN (${sqlList(HISTORY_MODES)})
  AND r.origin IN (${sqlList(MEMORY_ORIGINS)})
  AND (r.cancel_origin IS NULL OR r.cancel_origin IN (${sqlList(CANCEL_ORIGINS)}))
  AND (r.stop_reason IS NULL OR r.stop_reason IN (${sqlList(STOP_REASONS)}))
  AND EXISTS (SELECT 1 FROM sessions known WHERE known.id = r.session_id AND known.permission_mode IN (${sqlList(PERMISSION_MODES)}))
`;

const CLAIMABLE = `
  ${KNOWN_RUN_VALUES}
  AND (
    (r.status = 'QUEUED' AND r.available_at <= :now)
    OR (r.status IN ('RUNNING', 'CANCELLING') AND r.available_at <= :now AND (r.lease_expires_at IS NULL OR r.lease_expires_at <= :now))
  )
  AND NOT (r.status = 'CANCELLING' AND r.cancel_origin IN ('QUEUED', 'WAITING_HUMAN'))
  AND NOT EXISTS (
    SELECT 1 FROM runs earlier
    WHERE earlier.session_id = r.session_id
      AND earlier.ordinal < r.ordinal
      AND earlier.status NOT IN ('COMPLETED', 'STOPPED', 'FAILED', 'CANCELLED')
  )
  AND NOT EXISTS (
    SELECT 1 FROM runs earlier
    WHERE earlier.session_id = r.session_id
      AND earlier.ordinal < r.ordinal
      AND (earlier.history_mode NOT IN (${sqlList(HISTORY_MODES)}) OR (earlier.stop_reason IS NOT NULL AND earlier.stop_reason NOT IN (${sqlList(STOP_REASONS)})))
  )
`;

export const FIDELITY_PRUNE_BATCH_ROWS = 500;

const TAKEOVER = "(r.status IN ('RUNNING', 'CANCELLING') AND r.lease_owner IS NOT NULL)";

const RUN_MAX_ATTEMPTS = "MIN(:maxAttempts, COALESCE(json_extract(r.limits_json, '$.maxFailedAttempts'), :maxAttempts))";

const EXHAUSTED = `((${TAKEOVER} AND r.failed_attempts + 1 >= ${RUN_MAX_ATTEMPTS}) OR r.attempts + 1 > :maxTotalAttempts)`;

const CLAIM_ORDER = 'ORDER BY r.available_at, r.created_at, r.rowid';

const RUN_INSERT_SQL = `
  INSERT INTO runs (
    id, session_id, ordinal, idempotency_key, request_digest, previous_run_id, history_mode, parent_run_id, parent_call_id, status, version, lease_token,
    available_at, attempts, failed_attempts, cancel_requested, deadline_at, limits_json, usage_json, step, last_seq, pins, dead_letter, created_at, origin
  ) VALUES (
    :id, :sessionId, :ordinal, :idempotencyKey, :requestDigest, :previousRunId, :historyMode, :parentRunId, :parentCallId, 'QUEUED', 0, 0,
    :availableAt, 0, 0, 0, :deadlineAt, :limits, :usage, 0, 0, :pins, 0, :createdAt, :origin
  )
`;

const RUN_WRITE_SQL = `
  UPDATE runs SET
    status = :status,
    stop_reason = :stopReason,
    version = :version,
    lease_owner = :leaseOwner,
    lease_generation = CASE WHEN :leaseOwner IS NULL THEN NULL ELSE lease_generation END,
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
    dead_letter = :deadLetter,
    cancel_origin = :cancelOrigin
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
    `INSERT INTO sessions (id, cwd, env_json, permission_mode, model, bypass_allowed, additional_directories_json, mcp_servers_json, created_at)
     VALUES (:id, :cwd, :env, :permissionMode, :model, :bypassAllowed, :additionalDirectories, :mcpServers, :createdAt)`,
  ),
  updateSessionMcpServers: db.prepare('UPDATE sessions SET mcp_servers_json = :mcpServers WHERE id = :id'),
  updateSessionMode: db.prepare('UPDATE sessions SET permission_mode = :permissionMode WHERE id = :id'),
  updateSessionModel: db.prepare('UPDATE sessions SET model = :model WHERE id = :id'),
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
  treeSpend: db.prepare(
    `WITH RECURSIVE tree(id) AS (SELECT :rootId UNION ALL SELECT r.id FROM runs r JOIN tree t ON r.parent_run_id = t.id)
     SELECT COALESCE(SUM(json_extract(r.usage_json, '$.totalTokens')), 0) AS total_tokens,
            COALESCE(SUM(json_extract(r.usage_json, '$.costNano')), 0) AS cost_nano,
            COALESCE(SUM(json_extract(r.usage_json, '$.unpricedCalls')), 0) AS unpriced_calls,
            COALESCE(SUM(CASE WHEN r.id = :exceptId OR r.status IN (${TERMINAL_LIST}) THEN 0 ELSE r.reserved_tokens END), 0) AS reserved_tokens,
            COALESCE(SUM(CASE WHEN r.id = :exceptId OR r.status IN (${TERMINAL_LIST}) THEN 0 ELSE r.reserved_nano END), 0) AS reserved_nano,
            COUNT(*) AS runs_read
     FROM runs r JOIN tree t ON r.id = t.id`,
  ),
  reserveBudget: db.prepare('UPDATE runs SET reserved_tokens = :tokens, reserved_nano = :nano WHERE id = :id'),
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
  pruneFidelityVerdicts: db.prepare(
    `DELETE FROM fidelity_verdicts WHERE (run_id, cwd, fold_version, token) IN (
       SELECT run_id, cwd, fold_version, token FROM fidelity_verdicts WHERE fold_version < :bound LIMIT :limit
     )`,
  ),
  dataVersion: db.prepare('PRAGMA data_version'),
  selectRun: db.prepare('SELECT * FROM runs WHERE id = :id'),
  leaseTokenOf: db.prepare('SELECT lease_token FROM runs WHERE id = :runId'),
  latestEventSeq: db.prepare('SELECT seq FROM events WHERE run_id = :runId AND type = :type AND seq < :beforeSeq ORDER BY seq DESC LIMIT 1'),
  eventAt: db.prepare('SELECT * FROM events WHERE run_id = :runId AND seq = :seq'),
  latestSessionEventTime: db.prepare('SELECT created_at FROM events WHERE session_id = :sessionId ORDER BY id DESC LIMIT 1'),
  activeRunExists: db.prepare(
    `SELECT EXISTS (SELECT 1 FROM runs WHERE session_id = :sessionId AND status NOT IN (${TERMINAL_STATUSES.map((status) => `'${status}'`).join(', ')})) AS active`,
  ),
  anyActiveRunExists: db.prepare(`SELECT EXISTS (SELECT 1 FROM runs WHERE status NOT IN (${TERMINAL_LIST})) AS active`),
  selectRunByKey: db.prepare('SELECT * FROM runs WHERE session_id = :sessionId AND idempotency_key = :key'),
  listRuns: db.prepare('SELECT * FROM runs WHERE session_id = :sessionId ORDER BY ordinal'),
  terminalRunIdsWithCheckpoint: db.prepare(
    `SELECT r.id FROM runs r
     WHERE r.status IN (${TERMINAL_LIST})
       AND EXISTS (
         SELECT 1 FROM idempotency i
         WHERE i.state = 'PENDING'
           AND json_extract(i.meta_json, '$.runId') = r.id
           AND json_type(i.meta_json, '$.checkpoint') = 'object'
       )
     ORDER BY r.created_at, r.rowid`,
  ),
  latestRunOfSession: db.prepare('SELECT id FROM runs WHERE session_id = :sessionId ORDER BY ordinal DESC LIMIT 1'),
  nextOrdinal: db.prepare('SELECT COALESCE(MAX(ordinal), 0) + 1 AS next FROM runs WHERE session_id = :sessionId'),
  insertRun: db.prepare(RUN_INSERT_SQL),
  writeRun: db.prepare(RUN_WRITE_SQL),
  insertEvent: db.prepare(
    `INSERT INTO events (run_id, session_id, seq, step, lease_token, created_at, type, payload_json, pinned_digest, call_id, approval_id, tool_name, notice_code, model_call_json)
     VALUES (:runId, :sessionId, :seq, :step, :leaseToken, :createdAt, :type, :payload, :pinnedDigest, :callId, :approvalId, :toolName, :noticeCode, :modelCallJson)`,
  ),
  dueWaitingRuns: db.prepare(
    `SELECT r.id FROM runs r
     WHERE ${KNOWN_RUN_VALUES}
       AND (
         (r.status = 'QUEUED' AND r.deadline_at <= :nowMs)
         OR (
           r.status = 'WAITING_HUMAN'
           AND (
             r.deadline_at <= :nowMs
             OR EXISTS (SELECT 1 FROM approvals a WHERE a.run_id = r.id AND a.status = 'pending' AND a.expires_at <= :nowMs)
           )
         )
         OR (r.status = 'WAITING_TOOL' AND r.available_at <= :nowMs)
       )
     ORDER BY r.created_at, r.rowid`,
  ),
  runEvents: db.prepare('SELECT * FROM events WHERE run_id = :runId AND seq > :after ORDER BY seq LIMIT :limit'),
  lastTerminalRootRuns: db.prepare(
    `SELECT r.* FROM runs r JOIN sessions s ON s.id = r.session_id
     WHERE s.cwd = :project AND r.parent_run_id IS NULL AND r.status IN (${TERMINAL_LIST})
       AND EXISTS (SELECT 1 FROM events e WHERE e.run_id = r.id AND e.type = 'run.started')
     ORDER BY r.created_at DESC, r.rowid DESC LIMIT :limit`,
  ),
  toolOfferedNames: db.prepare(
    `WITH RECURSIVE tree(id) AS (SELECT :runId UNION ALL SELECT r.id FROM runs r JOIN tree t ON r.parent_run_id = t.id)
     SELECT DISTINCT n.value AS name
     FROM tree t
     JOIN events e ON e.run_id = t.id AND e.seq = (SELECT MAX(o.seq) FROM events o WHERE o.run_id = t.id AND o.type = 'tool.offered')
     JOIN json_each(e.payload_json, '$.names') n
     ORDER BY name`,
  ),
  hasToolOffered: db.prepare("SELECT 1 AS present FROM events WHERE run_id = :runId AND type = 'tool.offered' LIMIT 1"),
  modelChanges: db.prepare("SELECT * FROM events WHERE session_id = :sessionId AND type = 'model.changed' AND id > :after ORDER BY id"),
  sessionEvents: db.prepare('SELECT * FROM events WHERE session_id = :sessionId AND id > :after ORDER BY id LIMIT :limit'),
  pendingUserShell: db.prepare(
    `SELECT * FROM events WHERE session_id = :sessionId AND run_id IS NULL AND type = 'user_shell'
       AND id > COALESCE((SELECT MAX(id) FROM events WHERE session_id = :sessionId AND type = 'user.message' AND seq = 1), 0)
     ORDER BY id`,
  ),
  listExhausted: db.prepare(`SELECT r.* FROM runs r WHERE ${CLAIMABLE} AND ${EXHAUSTED} ${CLAIM_ORDER}`),
  exhaustedById: db.prepare(`SELECT r.* FROM runs r WHERE r.id = :id AND ${CLAIMABLE} AND ${EXHAUSTED}`),
  listSweeperOwned: db.prepare(
    `SELECT r.* FROM runs r
     WHERE ${KNOWN_RUN_VALUES} AND r.status = 'CANCELLING' AND r.cancel_origin IN ('QUEUED', 'WAITING_HUMAN') AND (r.lease_owner IS NULL OR r.lease_expires_at <= :now)
     ORDER BY r.created_at, r.rowid`,
  ),
  sweeperOwnedById: db.prepare(
    `SELECT r.* FROM runs r
     WHERE r.id = :id AND ${KNOWN_RUN_VALUES} AND r.status = 'CANCELLING' AND r.cancel_origin IN ('QUEUED', 'WAITING_HUMAN') AND (r.lease_owner IS NULL OR r.lease_expires_at <= :now)`,
  ),
  claimTakeover: db.prepare(
    `SELECT CASE WHEN ${TAKEOVER} THEN r.lease_expires_at END AS taken_from
     FROM runs r WHERE ${CLAIMABLE} AND NOT ${EXHAUSTED} ${CLAIM_ORDER} LIMIT 1`,
  ),
  claim: db.prepare(
    `UPDATE runs SET
       status = CASE WHEN status = 'QUEUED' THEN 'RUNNING' ELSE status END,
       version = version + 1,
       lease_owner = :workerId,
       lease_generation = :generation,
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
  heldWithUnknownStatus: db.prepare(
    `SELECT * FROM runs WHERE id = :runId AND lease_token = :leaseToken AND lease_owner = :workerId AND status NOT IN (${sqlList(RUN_STATUSES)})`,
  ),
  releaseHeldLease: db.prepare(
    `UPDATE runs SET version = version + 1, lease_owner = NULL, lease_generation = NULL, lease_expires_at = NULL, available_at = :availableAt, failed_attempts = 0, attempts = :attempts
     WHERE id = :runId AND lease_token = :leaseToken AND lease_owner = :workerId`,
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
  edges: Record<Stored<RunStatus>, readonly RunStatus[]>;
  availableAt?: number;
  patch?: StatusPatch;
  deadLetter?: boolean;
  resetFailures?: boolean;
  refundAttempt?: boolean;
};

const decodeModelCallRecord = (row: Row): ModelCallRecord => {
  const seq = readerFor('events', 'model call', row).number('seq');
  const identity = `seq ${seq}`;
  const reader = readerFor('events', identity, row);
  const step = reader.number('step');
  const type = reader.string('type');
  const detail = expectRecord('events', identity, 'model_call_json', reader.json('model_call_json'));
  const attempt = detail['attempt'];
  if (typeof attempt !== 'number') throw corrupt('events', identity, 'column model_call_json carries no attempt');
  if (type === 'model.requested') {
    const anatomy = detail['anatomy'] ?? null;
    const prefix = detail['prefix'] ?? null;
    return { kind: 'requested', seq, step, attempt, ...(anatomy === null ? {} : { anatomy: anatomy as TokenAnatomy }), ...(prefix === null ? {} : { prefix: prefix as RunTracePrefix }) };
  }
  const timing = detail['timing'] ?? null;
  const responseIdValue = detail['responseId'] ?? null;
  if (responseIdValue !== null && typeof responseIdValue !== 'string') throw corrupt('events', identity, 'column model_call_json carries a response id that is not a string');
  const responseId = responseIdValue;
  return { kind: 'responded', seq, step, attempt, ...(responseId === null ? {} : { responseId }), ...(timing === null ? {} : { timing: expectRecord('events', identity, 'timing', timing) as CallTiming }) };
};

const assertPositiveInteger = (name: string, value: number): void => {
  if (!Number.isInteger(value) || value < 1) throw new RangeError(`openRuntimeStore: ${name} must be a positive integer, got ${value}`);
};

export const migrateRuntimeDatabase = (file: string): void => {
  const db = openDatabase(file);
  try {
    migrate(db, MIGRATIONS);
  } finally {
    db.close();
  }
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
  const { clock, leaseMs, maxAttempts, maxTotalAttempts, home, fileSystem, random } = options;
  const { db, identity } = openDatabaseWithIdentity(options.path);
  let statements: Statements;
  try {
    migrate(db, MIGRATIONS);
    statements = prepareStatements(db);
  } catch (error) {
    db.close();
    throw error;
  }
  const sql = statements;
  const lifetime = new AbortController();
  const blobs = createBlobStore(db, clock, blobDirectoryOf(options.path), { fileSystem, random });
  const decodeContext = decodeContextOf(db);
  const approvalOps = createApprovalStore(db, clock, decodeContext);
  const memories = createMemoryStore(db, clock, decodeContext);
  const contextCharges = createContextChargeStore(db, clock, decodeContext);
  const reflection = createReflectionStore(db, clock, { memories, contextCharges }, decodeContext);
  const governing = createGoverningFactStore(db, clock, decodeContext);
  const runFacts = createRunFactsStore(db, decodeContext);
  const journalReader = createJournalReader(db, { lookups: { memories, governing }, ...(options.onDecode === undefined ? {} : { onDecode: options.onDecode }) });
  const trust = createTrustStore(db, clock, home, decodeContext, fileSystem);
  const ruleVerdicts = createRuleVerdictStore(db, clock);
  const originOf = async (cwd: string): Promise<MemoryOrigin> => ((await trust.decisionAsked(cwd, lifetime.signal)).decision === 'trusted' ? 'trusted' : 'untrusted');
  const touched = new Map<string, { runId?: string; sessionId: string }>();
  const preparer = options.preparer;
  const { onDecode, onEncode } = options;
  const records = createAppendRecords(db, onDecode === undefined ? {} : { onDecode });
  const verdicts = createVerdictWriter(db);
  const derived = createDerivedRepair(db, records, decodeContext);
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
  const derivedReads = createDerivedReads(db, derived, records, transaction);
  const derivedView = derivedReads.view;


  const observeDecode = (rows: readonly Row[]): void => {
    if (onDecode === undefined) return;
    onDecode(rows.length, rows.reduce((bytes, row) => bytes + (typeof row['payload_json'] === 'string' ? Buffer.byteLength(row['payload_json']) : 0), 0));
  };

  const decodeEvents = (rows: readonly Row[]): RunEvent[] => {
    observeDecode(rows);
    return decodeRunEvents(rows, decodeContext);
  };

  const decodeKnownEvents = (rows: readonly Row[]): (RunEvent | SessionEvent)[] => {
    observeDecode(rows);
    return rows.flatMap((row) => decodeKnownEvent(row, decodeContext) ?? []);
  };

  const fillPage = <E>(after: number, limit: number, fetch: (after: number, limit: number) => Row[], cursorOf: (row: Row) => number, decode: (rows: readonly Row[]) => E[]): E[] => {
    const kept: E[] = [];
    for (let cursor = after; ; ) {
      const wanted = limit - kept.length;
      const rows = fetch(cursor, wanted);
      kept.push(...decode(rows));
      const last = rows.at(-1);
      if (last === undefined || rows.length < wanted || kept.length >= limit) return kept;
      cursor = cursorOf(last);
    }
  };

  const decodeStreamEvents = (rows: readonly Row[]): (RunEvent | SessionEvent | OpaqueEvent)[] => {
    observeDecode(rows);
    return rows.map((row) => decodeStoredEvent(row, decodeContext));
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
    const payload = canonicalJson(event.payload);
    onEncode?.('event', Buffer.byteLength(payload));
    const inserted = sql.insertEvent.run({
      runId: event.runId,
      sessionId: event.sessionId,
      seq: event.seq,
      step: event.step,
      leaseToken: event.leaseToken,
      createdAt: event.createdAt,
      type: event.payload.type,
      payload,
      pinnedDigest: event.payload.type === 'model.requested' ? (event.payload.pinnedDigest ?? null) : null,
      ...columnsOf(event.payload),
    });
    if (event.runId !== null && event.seq !== null && event.step !== null) derived.recordAppended({ eventId: Number(inserted.lastInsertRowid), runId: event.runId, sessionId: event.sessionId, seq: event.seq, step: event.step, payload: event.payload });
    recordTouch(event.sessionId, event.runId);
  };

  const approvalAnnounced = (runId: string, approvalId: string): boolean =>
    derivedView.permissionRequestOf(runId, approvalId) !== undefined || derivedView.elicitationRequested(runId, approvalId) || derivedView.unknownRequestOf(runId, approvalId) !== undefined;

  const cancelledEvent = (approval: Approval, reason: 'expired' | 'withdrawn' | 'superseded'): RunEventPayload =>
    approval.kind === 'elicitation'
      ? { type: 'tool.elicitation.cancelled', inputId: approval.id, reason }
      : approval.kind === 'unknown_effect'
        ? { type: 'tool.unknown.cancelled', approvalId: approval.id, reason }
        : { type: 'tool.permission.cancelled', approvalId: approval.id, reason };

  const requireRun = (runId: string): Run => {
    const row = sql.selectRun.get({ id: runId });
    if (row === undefined) throw new Error(`unknown run ${runId}`);
    return decodeRun(row, decodeContext);
  };

  const requestBodies = new Map<string, { leaseToken: number; event: Extract<RunEvent, { type: 'model.requested' }> }>();

  const readLatestRequest = (runId: string, beforeSeq: number): Extract<RunEvent, { type: 'model.requested' }> | undefined => {
    const latest = sql.latestEventSeq.get({ runId, type: 'model.requested', beforeSeq });
    if (latest === undefined) return undefined;
    const seq = Number(latest.seq);
    const leaseToken = Number(sql.leaseTokenOf.get({ runId })?.lease_token);
    const cached = requestBodies.get(runId);
    if (cached !== undefined && cached.leaseToken === leaseToken && cached.event.seq === seq) return cached.event;
    const [decoded] = decodeEvents(sql.eventAt.all({ runId, seq }));
    if (decoded === undefined || decoded.type !== 'model.requested') throw new Error(`run ${runId} seq ${seq} is not a model.requested event`);
    if (cached === undefined || cached.leaseToken !== leaseToken || cached.event.seq < seq) requestBodies.set(runId, { leaseToken, event: decoded });
    return decoded;
  };

  const writeRun = (run: Run): void => {
    refuseUnknown(`run ${run.id}`, [run.status, run.stopReason, run.cancelOrigin]);
    if (run.leaseOwner === null) requestBodies.delete(run.id);
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
      cancelOrigin: run.cancelOrigin,
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
      const spend = spendOf(payload);
      const usage = spend === undefined ? current.usage : addUsage(current.usage, spend);
      current = { ...current, step, lastSeq: seq, usage };
    }
    return current;
  };

  const withdrawPendingApprovals = (runId: string): RunEventPayload[] =>
    approvalOps.store.listPending(runId).flatMap((approval): RunEventPayload[] => {
      approvalOps.end(approval.id, 'withdrawn');
      return approvalAnnounced(runId, approval.id) ? [cancelledEvent(approval, 'withdrawn')] : [];
    });

  type Need = { runId: string; leading: readonly RunEventPayload[]; expiring: readonly string[] };
  type Prepared = Need & { measured: ContributionMeasured | undefined };

  const operate = async <T>(scope: DerivedScope, plan: () => Need | undefined, commit: (prepared: Prepared | undefined) => T): Promise<T> => {
    for (;;) {
      const need = await derivedReads.read(scope, plan);
      let prepared: Prepared | undefined;
      if (need !== undefined) {
        prepared = preparer === undefined ? { ...need, measured: undefined } : { ...need, measured: await preparer.measure({ runId: need.runId, leading: need.leading }) };
      }
      try {
        return await derivedReads.write(scope, () => commit(prepared));
      } catch (error) {
        if (!(error instanceof StalePreparation) || preparer === undefined) throw error;
      }
    }
  };

  const settleContribution = (run: Run, to: TerminalStatus, prepared: Prepared | undefined): RunEventPayload[] => {
    if (preparer === undefined) return [];
    if (prepared === undefined || prepared.runId !== run.id || prepared.measured === undefined || prepared.measured.lastSeq !== run.lastSeq) throw new StalePreparation(run.id);
    const { contribution } = prepared.measured;
    if (contribution === undefined) return [];
    if (to === 'COMPLETED') {
      memories.stampContributed(
        contribution.items.filter((item) => item.kind === 'memory' && item.contributed).map((item) => item.id),
        clock.now(),
      );
    }
    return [{ type: 'context.contribution', items: contribution.items }];
  };

  const inboxTable = createInboxTable(db, clock, decodeContext);

  const announceInbox = (sessionId: string): InboxRow[] => {
    const pending = inboxTable.pending(sessionId);
    insertEvent({ runId: null, sessionId, seq: null, step: null, leaseToken: null, createdAt: clock.now(), payload: { type: 'inbox.changed', pending: pending.map(inboxRowView) } });
    return pending;
  };

  const pendingUserShell = (sessionId: string): UserShellRecord[] =>
    sql.pendingUserShell.all({ sessionId }).map((row) => {
      const identity = String(row['id']);
      return userShellRecordOf(identity, expectRecord('events', identity, 'payload_json', readerFor('events', identity, row).json('payload_json')));
    });

  const insertRootRun = (sessionRow: Row, input: CreateRunInput, origin: Stored<MemoryOrigin>, source?: InboxDelivery): Run => {
    const session = decodeSession(sessionRow, decodeContext);
    const sessionId = session.id;
    const ordinalRow = sql.nextOrdinal.get({ sessionId });
    if (ordinalRow === undefined) throw new Error(`could not compute the next run ordinal for session ${sessionId}`);
    const ordinal = readerFor('runs', sessionId, ordinalRow).number('next');
    const previous = sql.latestRunOfSession.get({ sessionId });
    const shell = pendingUserShell(sessionId);
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
      pins: canonicalJson(input.mandate === undefined ? input.pins : { ...input.pins, mandate: input.mandate }),
      createdAt: now,
      origin,
    });
    const inserted = appendPayloads(requireRun(id), [
      {
        type: 'user.message',
        text: input.input,
        ...(input.images === undefined ? {} : { images: input.images }),
        ...(source === undefined ? {} : { source }),
        ...(input.attachments === undefined || input.attachments.length === 0 ? {} : { attachments: input.attachments }),
        ...(shell.length === 0 ? {} : { shell }),
      },
      ...(input.skill === undefined ? [] : [{ type: 'skill.activated' as const, name: input.skill.name, content: input.skill.content }]),
    ]);
    writeRun(inserted);
    return requireRun(id);
  };

  const startNextQueued = (sessionId: string, terms: QueuedRunTerms, origin: Stored<MemoryOrigin>): void => {
    if (inboxTable.pendingCount(sessionId) === 0 || inboxTable.sessionHasOpenRun(sessionId)) return;
    const sessionRow = sql.selectSession.get({ id: sessionId });
    if (sessionRow === undefined) throw new Error(`session ${sessionId} of a waiting message does not exist`);
    inboxTable.queuePendingSteer(sessionId);
    const head = inboxTable.firstQueued(sessionId);
    if (head === undefined) return;
    if (!inboxTable.settle(head.id, 'delivered')) throw new Error(`the first waiting message of session ${sessionId} could not be delivered`);
    insertRootRun(sessionRow, { input: head.text, ...(head.images === undefined ? {} : { images: head.images }), timeoutMs: terms.timeoutMs, limits: terms.limits, pins: {}, history: 'inherit' }, origin, 'queue');
    announceInbox(sessionId);
  };

  const cancelOriginOf = (status: RunStatus): CancelOrigin => {
    const origin = CANCEL_ORIGINS.find((candidate) => candidate === status);
    if (origin === undefined) throw new Error(`a run in status ${status} cannot become CANCELLING`);
    return origin;
  };

  const changeStatus = (run: Run, to: RunStatus, change: StatusChange, leadingEvents: readonly RunEventPayload[] = [], prepared?: Prepared): Run => {
    if (!change.edges[run.status].includes(to)) throw new Error(`run ${run.id} has no permitted edge ${run.status} -> ${to}`);
    const from = knownStatusOf(run);
    const patch = change.patch ?? {};
    const reason = patch.stopReason ?? patch.error?.code;
    const statusEvent: RunEventPayload = { type: 'run.status', from, to, ...(reason === undefined ? {} : { reason }) };
    const withdrawal = isTerminal(to) || to === 'CANCELLING' ? withdrawPendingApprovals(run.id) : [];
    const contribution = isTerminal(to) ? settleContribution(run, to, prepared) : [];
    const appended = appendPayloads(run, [...leadingEvents, ...withdrawal, ...contribution, statusEvent]);
    if (to === 'COMPLETED' && run.parentRunId === null) reflection.enqueue(run.id);
    const keepsLease = to === 'RUNNING' || to === 'CANCELLING';
    const wakesNow = to === 'QUEUED' || (to === 'CANCELLING' && run.leaseOwner === null);
    const availableAt = change.availableAt ?? (wakesNow ? clock.now() : run.availableAt);
    const next: Run = {
      ...appended,
      status: to,
      version: run.version + 1,
      cancelRequested: run.cancelRequested || to === 'CANCELLING' || to === 'CANCELLED',
      cancelOrigin: to === 'CANCELLING' ? cancelOriginOf(from) : null,
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
    if (isTerminal(to) && run.parentRunId === null) startNextQueued(run.sessionId, { timeoutMs: run.deadlineAt - run.createdAt, limits: run.limits }, run.origin);
    return requireRun(run.id);
  };

  const cancelChildren = (runId: string): void => {
    for (const row of sql.childRuns.all({ runId })) {
      const child = decodeRun(row, decodeContext);
      if (isTerminal(child.status) || child.status === 'CANCELLING' || child.status === UNKNOWN_VALUE) continue;
      changeStatus(child, 'CANCELLING', { edges: SERVICE_TRANSITIONS });
    }
  };

  const treeSpendOf = (runId: string, exceptId: string | null): TreeSpend & { runsRead: number } => {
    const row = sql.treeSpend.get({ rootId: rootRunIdOf(runId), exceptId });
    if (row === undefined) throw new Error(`could not compute the spend of the run tree of ${runId}`);
    const reader = readerFor('runs', runId, row);
    return {
      totalTokens: reader.number('total_tokens'),
      costNano: reader.number('cost_nano'),
      unpricedCalls: reader.number('unpriced_calls'),
      reservedTokens: reader.number('reserved_tokens'),
      reservedNano: reader.number('reserved_nano'),
      runsRead: reader.number('runs_read'),
    };
  };

  const wakeRun = (runId: string): void => {
    const run = requireRun(runId);
    if (run.status !== 'WAITING_TOOL') return;
    changeStatus(run, 'QUEUED', { edges: SERVICE_TRANSITIONS, availableAt: clock.now() });
  };

  const wakeParent = (child: Run): void => {
    if (child.parentRunId !== null) wakeRun(child.parentRunId);
  };

  const deadLetter = (run: Run, prepared: Prepared | undefined): void => {
    const overTotal = run.attempts + 1 > maxTotalAttempts;
    const ownMaximum = run.limits['maxFailedAttempts'];
    const failedMaximum = typeof ownMaximum === 'number' ? Math.min(maxAttempts, ownMaximum) : maxAttempts;
    const error = overTotal
      ? { code: 'max_total_attempts', message: `run ${run.id} exceeded ${maxTotalAttempts} total attempts` }
      : { code: 'max_attempts', message: `run ${run.id} exceeded ${failedMaximum} consecutive failed attempts` };
    const cancelled = run.cancelRequested || run.status === 'CANCELLING';
    changeStatus(run, cancelled ? 'CANCELLED' : 'FAILED', {
      edges: DEAD_LETTER_TRANSITIONS,
      deadLetter: true,
      patch: { error },
    }, [], prepared);
  };

  const fenced = (claim: LeaseFence): Run | undefined => {
    const row = sql.fence.get({ runId: claim.runId, leaseToken: claim.leaseToken, workerId: claim.workerId });
    return row === undefined ? undefined : decodeRun(row, decodeContext);
  };

  const leaseLost: LeaseLost = { kind: 'lease_lost' };

  const releaseUntouched = (run: Run, claim: LeaseFence, options: { availableAt: number; refundAttempt?: boolean }): RunMutationResult => {
    requestBodies.delete(run.id);
    sql.releaseHeldLease.run({
      runId: claim.runId,
      leaseToken: claim.leaseToken,
      workerId: claim.workerId,
      availableAt: options.availableAt,
      attempts: refundedAttempts(run, options.refundAttempt),
    });
    return { kind: 'ok', run: requireRun(run.id) };
  };

  const conflict = (reason: string): Conflict => ({ kind: 'conflict', reason });

  const moveWorker = (
    run: Run,
    from: readonly RunStatus[],
    to: RunStatus,
    change: Omit<StatusChange, 'edges' | 'resetFailures'>,
    preceding: readonly RunEventPayload[] = [],
    prepared?: Prepared,
  ): RunMutationResult => {
    if (!listed(from, run.status)) {
      return conflict(`run ${run.id} is ${run.status}, expected one of ${from.join(', ')}`);
    }
    if (!WORKER_TRANSITIONS[run.status].includes(to)) return conflict(`run ${run.id} cannot move from ${run.status} to ${to}`);
    return { kind: 'ok', run: changeStatus(run, to, { ...change, edges: WORKER_TRANSITIONS, resetFailures: true }, preceding, prepared) };
  };

  const expiryEvents = (runId: string, approval: Approval): RunEventPayload[] => {
    if (approval.kind !== 'elicitation') throw corrupt('approvals', approval.id, 'only a request for input carries an expiry');
    const notice: RunEventPayload = {
      type: 'notice',
      level: 'warning',
      code: 'approval_expired',
      message: `The request for input for ${approval.callId} expired.`,
    };
    return approvalAnnounced(runId, approval.id)
      ? [cancelledEvent(approval, 'expired'), notice]
      : [notice];
  };

  type StopPlan = { patch: StatusPatch; edges: StatusChange['edges']; leading: RunEventPayload[]; expiring: string[] };

  const planStop = (run: Run, nowMs: number): StopPlan | undefined => {
    if (run.status === 'QUEUED') return run.deadlineAt <= nowMs ? { patch: { stopReason: 'timeout' }, edges: SWEEP_TRANSITIONS, leading: [], expiring: [] } : undefined;
    if (run.status !== 'WAITING_HUMAN') return undefined;
    const due = approvalOps.listPendingDue(run.id, nowMs);
    if (due.length > 0) {
      return { patch: { stopReason: 'approval_timeout' }, edges: SERVICE_TRANSITIONS, leading: due.flatMap((approval) => expiryEvents(run.id, approval)), expiring: due.map((approval) => approval.id) };
    }
    return run.deadlineAt <= nowMs ? { patch: { stopReason: 'timeout' }, edges: SERVICE_TRANSITIONS, leading: [], expiring: [] } : undefined;
  };

  const stopNeed = (runId: string, nowMs: number): Need | undefined => {
    const row = sql.selectRun.get({ id: runId });
    const stop = row === undefined ? undefined : planStop(decodeRun(row, decodeContext), nowMs);
    return stop === undefined ? undefined : { runId, leading: stop.leading, expiring: stop.expiring };
  };

  const stopWaitingRun = (run: Run, nowMs: number, prepared: Prepared | undefined): boolean => {
    if (run.status === 'WAITING_TOOL') {
      if (run.availableAt > nowMs) return false;
      changeStatus(run, 'QUEUED', { edges: SERVICE_TRANSITIONS, availableAt: nowMs });
      return true;
    }
    const stop = planStop(run, nowMs);
    if (stop === undefined) return false;
    if (prepared === undefined) throw new StalePreparation(run.id);
    for (const approvalId of prepared.expiring) approvalOps.end(approvalId, 'expired');
    changeStatus(run, 'STOPPED', { edges: stop.edges, patch: stop.patch }, prepared.leading, prepared);
    return true;
  };

  const resolveInTransaction = (approvalId: string, optionId: string, now: number): ResolveApprovalResult => {
    const approval = approvalOps.store.get(approvalId);
    if (approval === undefined || (approval.kind !== 'permission' && approval.kind !== 'unknown_effect')) return { kind: 'not_found' };
    if (approval.status !== 'pending') return { kind: 'approval_not_pending', status: approval.status };
    if (!approvalAnnounced(approval.runId, approval.id)) return { kind: 'request_missing' };
    const run = requireRun(approval.runId);
    if (run.cancelRequested) return { kind: 'run_cancelled' };
    if (!approval.options.some((option) => option.optionId === optionId)) return { kind: 'option_not_offered' };
    const resolved = approvalOps.markResolved(approval.id, optionId);
    const event: RunEventPayload = { type: approval.kind === 'unknown_effect' ? 'tool.unknown.resolved' : 'tool.permission.resolved', approvalId: approval.id, optionId };
    const settled = run.status === 'WAITING_HUMAN' && approvalOps.store.listPending(run.id).length === 0;
    if (settled) {
      changeStatus(run, 'QUEUED', { edges: SERVICE_TRANSITIONS, availableAt: now }, [event]);
    } else {
      writeRun({ ...appendPayloads(run, [event]), version: run.version + 1 });
    }
    return { kind: 'ok', approval: resolved, run: requireRun(run.id) };
  };

  const lateInputNeed = (approvalId: string, now: number): Need | undefined => {
    const approval = approvalOps.store.get(approvalId);
    return approval !== undefined && approval.kind === 'elicitation' && approval.status === 'pending' && approval.expiresAt <= now ? stopNeed(approval.runId, now) : undefined;
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
    const row = derivedView.toolCallEventOf(approval.runId, approval.callId);
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

  const requestOf = (approval: Approval): { reason: string; suggestedRule?: string } => {
    const row = derivedView.permissionRequestOf(approval.runId, approval.id);
    if (row === undefined) throw corrupt('approvals', approval.id, `run ${approval.runId} has no tool.permission.requested event for approval ${approval.id}`);
    const payload = expectRecord('events', approval.id, 'payload_json', readerFor('events', approval.id, row).json('payload_json'));
    const { reason, suggestedRule } = payload;
    if (typeof reason !== 'string') throw corrupt('events', approval.id, 'reason must be a string');
    if (suggestedRule !== undefined && typeof suggestedRule !== 'string') throw corrupt('events', approval.id, 'suggestedRule must be a string');
    return { reason, ...(suggestedRule === undefined ? {} : { suggestedRule }) };
  };

  const titleOf = (approval: Approval, callId: string): string => {
    const row = derivedView.toolCallEventOf(approval.runId, callId);
    if (row === undefined) throw corrupt('approvals', approval.id, `run ${approval.runId} has no tool.call event for call ${callId}`);
    const { title } = expectRecord('events', approval.id, 'payload_json', readerFor('events', approval.id, row).json('payload_json'));
    if (typeof title !== 'string') throw corrupt('events', approval.id, 'tool.call payload must hold a string title');
    return title;
  };

  const foundOf = (approval: Approval, callId: string): string => {
    const row = derivedView.reconciledOf(approval.runId, callId);
    if (row === undefined) throw corrupt('approvals', approval.id, `run ${approval.runId} has no tool.reconciled event for call ${callId}`);
    const { output } = expectRecord('events', approval.id, 'payload_json', readerFor('events', approval.id, row).json('payload_json'));
    if (typeof output !== 'string') throw corrupt('events', approval.id, 'tool.reconciled payload must hold a string output');
    return output;
  };

  const unknownReasonOf = (approval: Approval): string => {
    const row = derivedView.unknownRequestOf(approval.runId, approval.id);
    if (row === undefined) throw corrupt('approvals', approval.id, `run ${approval.runId} has no tool.unknown.requested event for approval ${approval.id}`);
    const { callIds } = expectRecord('events', approval.id, 'payload_json', readerFor('events', approval.id, row).json('payload_json'));
    if (!Array.isArray(callIds) || !callIds.every((callId): callId is string => typeof callId === 'string')) throw corrupt('events', approval.id, 'callIds must be an array of strings');
    return unknownEffectLines(callIds.map((callId) => ({ title: titleOf(approval, callId), found: foundOf(approval, callId) }))).join('\n');
  };

  const viewOf = (approval: Approval): ApprovalView => {
    if (approval.kind !== 'permission' && approval.kind !== 'unknown_effect') throw corrupt('approvals', approval.id, `an approval of kind ${approval.kind} has no approval view`);
    const { reason, suggestedRule } = approval.kind === 'unknown_effect' ? { reason: unknownReasonOf(approval), suggestedRule: undefined } : requestOf(approval);
    return {
      id: approval.id,
      kind: approval.kind,
      runId: approval.runId,
      callId: approval.callId,
      status: approval.status,
      options: approval.options,
      createdAt: approval.createdAt,
      ...(suggestedRule === undefined ? {} : { suggestedRule }),
      reason,
      toolCall: toolCallOf(approval),
    };
  };

  const resolveElicitationInTransaction = (elicitationId: string, responses: Record<string, ElicitationAnswerRecord>, notices: readonly string[], now: number, prepared: Prepared | undefined): ResolveElicitationResult => {
    const approval = approvalOps.store.get(elicitationId);
    if (approval === undefined) return { kind: 'not_found' };
    if (approval.kind !== 'elicitation') return { kind: 'wrong_kind' };
    if (approval.status !== 'pending') return { kind: 'approval_not_pending', status: approval.status };
    if (!approvalAnnounced(approval.runId, approval.id)) return { kind: 'request_missing' };
    const run = requireRun(approval.runId);
    if (approval.expiresAt <= now) {
      stopWaitingRun(run, now, prepared);
      return { kind: 'approval_not_pending', status: 'expired' };
    }
    if (run.cancelRequested) return { kind: 'run_cancelled' };
    const answered = approvalOps.markAnswered(approval.id, responses);
    const event: RunEventPayload = { type: 'tool.elicitation.resolved', inputId: approval.id, responses };
    const events: RunEventPayload[] = [event, ...notices.map((message): RunEventPayload => ({ type: 'notice', level: 'warning', message, code: 'elicitation_validator_failed' }))];
    const settled = run.status === 'WAITING_HUMAN' && approvalOps.store.listPending(run.id).length === 0;
    if (settled) {
      changeStatus(run, 'QUEUED', { edges: SERVICE_TRANSITIONS, availableAt: now }, events);
    } else {
      writeRun({ ...appendPayloads(run, events), version: run.version + 1 });
    }
    return { kind: 'ok', elicitation: answered, run: requireRun(run.id) };
  };

  const elicitationViewOf = (approval: Approval): ElicitationView => {
    if (approval.kind !== 'elicitation' || approval.server === undefined || approval.requests === undefined) {
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
    return { run: decodeRun(row, decodeContext), requestDigest: readerFor('runs', String(row['id']), row).nullableString('request_digest') };
  };

  const hasInheritedEvent = (runId: string): boolean => sql.inheritedEvent.get({ runId }) !== undefined;

  const loadInReadTx = (runId: string): LoadedRun => {
    requireRun(runId);
    const row: Row | undefined = sql.latestSnapshot.get({ runId });
    if (row === undefined) return { tail: decodeEvents(sql.runEvents.all({ runId, after: 0, limit: -1 })) };
    const identity = `${runId}@${String(row['seq'])}`;
    const reader = readerFor('snapshots', identity, row);
    const seq = reader.number('seq');
    const state = decodeRunState(identity, reader.json('state_json'));
    if (state === undefined) return { tail: decodeEvents(sql.runEvents.all({ runId, after: 0, limit: -1 })) };
    if (state.runId !== runId) throw corrupt('snapshots', identity, `state belongs to run ${state.runId}`);
    return { snapshot: { seq, state }, tail: decodeEvents(sql.runEvents.all({ runId, after: seq, limit: -1 })) };
  };

  const writeInheritance = (claim: Claim, plan: Extract<InheritPlanReply, { kind: 'ready' }>): InheritContextResult =>
    transaction<InheritContextResult>(() => {
      const run = fenced(claim);
      if (run === undefined) return leaseLost;
      if (hasInheritedEvent(run.id)) return { kind: 'already' };
      for (const walkedRun of plan.walked) {
        const row = sql.selectRun.get({ id: walkedRun.runId });
        const current = row === undefined ? undefined : decodeRun(row, decodeContext);
        if (current === undefined || current.status !== walkedRun.status || current.lastSeq !== walkedRun.lastSeq) {
          return conflict(`run ${walkedRun.runId} changed while the context of run ${run.id} was being inherited`);
        }
      }
      writeRun(appendPayloads(run, [referencePayload(plan.payload)]));
      return { kind: 'inherited' };
    });

  const requireSession = (sessionId: string): Session => {
    const row = sql.selectSession.get({ id: sessionId });
    if (row === undefined) throw new Error(`unknown session ${sessionId}`);
    return decodeSession(row, decodeContext);
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
      return decodeJob(row, decodeContext).status !== 'running';
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
        if (existing !== undefined) return { job: decodeJob(existing, decodeContext), created: false };
        sql.jobs.insert.run({
          id: input.id,
          idemKey: input.idemKey,
          sessionId: rootSessionIdOf(input.sessionId),
          runId: input.runId,
          callId: input.callId,
          command: input.command,
          ownerGeneration: input.ownerGeneration ?? null,
          outputPath: input.outputPath ?? null,
          startedAt: clock.now(),
        });
        const row = sql.jobs.select.get({ id: input.id });
        if (row === undefined) throw new Error(`job ${input.id} vanished during start`);
        return { job: decodeJob(row, decodeContext), created: true };
      }),
    attachProcess: (id, pgid) => {
      if (Number(sql.jobs.attach.run({ id, pgid }).changes) !== 1) throw new Error(`cannot attach a process to job ${id}: it is not running`);
    },
    get: (id) => {
      const row = sql.jobs.select.get({ id });
      return row === undefined ? undefined : decodeJob(row, decodeContext);
    },
    byIdemKey: (idemKey) => {
      const row = sql.jobs.selectByKey.get({ idemKey });
      return row === undefined ? undefined : decodeJob(row, decodeContext);
    },
    listRunning: () => sql.jobs.running.all().map((row) => decodeJob(row, decodeContext)),
    listForSession: (sessionId) => sql.jobs.forSession.all({ sessionId: rootSessionIdOf(sessionId) }).map((row) => decodeJob(row, decodeContext)),
    finish: (id, result) =>
      transaction<FinishJobResult>(() => {
        const row = sql.jobs.select.get({ id });
        if (row === undefined) return { kind: 'not_found' };
        const job = decodeJob(row, decodeContext);
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
        return { kind: 'finished', job: decodeJob(finished, decodeContext) };
      }),
    advanceRead: (id, offset, call) => {
      sql.jobs.advance.run({ id, offset, call });
    },
    requestKill: (id) => Number(sql.jobs.requestKill.run({ id, now: clock.now() }).changes) === 1,
    clearOutputPath: (id) => {
      sql.jobs.clearOutputPath.run({ id });
    },
  };

  const rejectContribution = (events: readonly RunEventPayload[]): void => {
    if (events.some((event) => event.type === 'context.contribution')) {
      throw new Error('context.contribution is written only by the terminal transition of a run, never appended');
    }
  };

  const userShell: UserShellStore = {
    record: (sessionId, record) =>
      transaction<{ kind: 'recorded' } | { kind: 'not_found' }>(() => {
        if (sql.selectSession.get({ id: sessionId }) === undefined) return { kind: 'not_found' };
        insertEvent({ runId: null, sessionId, seq: null, step: null, leaseToken: null, createdAt: clock.now(), payload: { type: 'user_shell', ...record } });
        return { kind: 'recorded' };
      }),
    pending: pendingUserShell,
    runActive: (sessionId) => inboxTable.sessionHasOpenRun(sessionId),
  };

  const inbox: InboxStore = {
    add: async (sessionId, input) => {
      const asked = sql.selectSession.get({ id: sessionId });
      if (asked === undefined) return { kind: 'not_found' };
      const origin = await originOf(decodeSession(asked, decodeContext).cwd);
      return transaction<InboxAddResult>(() => {
        if (sql.selectSession.get({ id: sessionId }) === undefined) return { kind: 'not_found' };
        if (inboxTable.pendingCount(sessionId) >= INBOX_MAX_PENDING) return { kind: 'full' };
        const added = inboxTable.insert({ id: uuidv7(clock), sessionId, delivery: input.delivery, text: input.text, images: input.images });
        const open = inboxTable.sessionHasOpenRun(sessionId);
        if (open) announceInbox(sessionId);
        else startNextQueued(sessionId, input.run, origin);
        const row = inboxTable.get(added.id);
        if (row === undefined) throw new Error(`inbox row ${added.id} vanished after it was written`);
        return { kind: 'added', row, pending: inboxTable.pending(sessionId) };
      });
    },
    withdraw: (id) =>
      transaction<InboxWithdrawResult>(() => {
        const found = inboxTable.get(id);
        if (found === undefined) return { kind: 'not_found' };
        if (found.state === UNKNOWN_VALUE) throw new Error(`inbox row ${id} has a state this build does not know; it is left as it is`);
        const changed = inboxTable.settle(id, 'withdrawn');
        if (changed) announceInbox(found.sessionId);
        const row = inboxTable.get(id);
        if (row === undefined) throw new Error(`inbox row ${id} vanished while it was withdrawn`);
        return { kind: row.state === 'delivered' ? 'already_delivered' : 'withdrawn', row, pending: inboxTable.pending(row.sessionId) };
      }),
    list: (sessionId) => inboxTable.pending(sessionId),
    deliverSteering: (claim) =>
      transaction<InboxDeliverResult>(() => {
        const run = fenced(claim);
        if (run === undefined) return leaseLost;
        const rows = inboxTable.pendingSteer(run.sessionId);
        if (rows.length === 0) return { kind: 'ok', delivered: [] };
        const delivered = rows.map((row) => {
          if (!inboxTable.settle(row.id, 'delivered')) throw new Error(`inbox row ${row.id} could not be delivered`);
          const settled = inboxTable.get(row.id);
          if (settled === undefined) throw new Error(`inbox row ${row.id} vanished while it was delivered`);
          return settled;
        });
        const next = appendPayloads(
          run,
          delivered.map((row): RunEventPayload => ({ type: 'user.message', text: row.text, ...(row.images === undefined ? {} : { images: row.images }), source: 'steer' })),
        );
        writeRun(next);
        derived.repairPage(next.id, next.lastSeq);
        announceInbox(run.sessionId);
        return { kind: 'ok', delivered };
      }),
    successorOf: (runId) => {
      const row = inboxTable.nextRunAfter(runId);
      return row === undefined ? undefined : decodeRun(row, decodeContext);
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
          model: input.model,
          bypassAllowed: input.bypassAllowed === true ? 1 : 0,
          additionalDirectories: canonicalJson(input.additionalDirectories ?? []),
          mcpServers: canonicalJson(input.mcpServers ?? {}),
          createdAt: clock.now(),
        });
        const row = sql.selectSession.get({ id });
        if (row === undefined) throw new Error(`session ${id} vanished during create`);
        return decodeSession(row, decodeContext);
      }),

    getSession: (id) => {
      const row = sql.selectSession.get({ id });
      return row === undefined ? undefined : decodeSession(row, decodeContext);
    },

    listSessions: (filter) =>
      (filter?.cwd === undefined ? sql.listSessions.all() : sql.listSessionsByCwd.all({ cwd: filter.cwd })).map((row) => decodeSession(row, decodeContext)),

    setPermissionMode: (sessionId, mode: PermissionMode) =>
      transaction<SetPermissionModeResult>(() => {
        const row = sql.selectSession.get({ id: sessionId });
        if (row === undefined) return { kind: 'not_found' };
        const session = decodeSession(row, decodeContext);
        if (session.permissionMode === mode) return { kind: 'ok', session, changed: false };
        sql.updateSessionMode.run({ id: sessionId, permissionMode: mode });
        propagateMode(sessionId, mode);
        insertEvent({ runId: null, sessionId, seq: null, step: null, leaseToken: null, createdAt: clock.now(), payload: { type: 'mode.changed', mode } });
        return { kind: 'ok', session: { ...session, permissionMode: mode }, changed: true };
      }),

    setModel: (sessionId, model: string) =>
      transaction<SetModelResult>(() => {
        const row = sql.selectSession.get({ id: sessionId });
        if (row === undefined) return { kind: 'not_found' };
        const session = decodeSession(row, decodeContext);
        if (session.model === model) return { kind: 'ok', session, changed: false };
        sql.updateSessionModel.run({ id: sessionId, model });
        insertEvent({
          runId: null,
          sessionId,
          seq: null,
          step: null,
          leaseToken: null,
          createdAt: clock.now(),
          payload: { type: 'model.changed', model, previousModel: session.model },
        });
        return { kind: 'ok', session: { ...session, model }, changed: true };
      }),

    setSessionMcpServers: (sessionId, servers) =>
      transaction<SetSessionMcpServersResult>(() => {
        const row = sql.selectSession.get({ id: sessionId });
        if (row === undefined) return { kind: 'not_found' };
        sql.updateSessionMcpServers.run({ id: sessionId, mcpServers: canonicalJson(servers) });
        return { kind: 'ok', session: { ...decodeSession(row, decodeContext), mcpServers: servers } };
      }),

    createRunAndEnqueue: async (sessionId, input) => {
      const asked = sql.selectSession.get({ id: sessionId });
      if (asked === undefined) return { kind: 'not_found' };
      const origin = await originOf(decodeSession(asked, decodeContext).cwd);
      return transaction<CreateRunResult>(() => {
        const sessionRow = sql.selectSession.get({ id: sessionId });
        if (sessionRow === undefined) return { kind: 'not_found' };
        if (input.idempotencyKey !== undefined) {
          const existing = findRunByIdempotencyKey(sessionId, input.idempotencyKey);
          if (existing !== undefined) {
            return sameRunRequest(existing, input.requestDigest) ? { kind: 'existing', run: existing.run } : { kind: 'key_reused' };
          }
        }
        return { kind: 'created', run: insertRootRun(sessionRow, input, origin) };
      });
    },

    createChildRun: async (input) => {
      const askedParent = sql.selectRun.get({ id: input.parentRunId });
      if (askedParent === undefined) return { kind: 'parent_not_active', status: 'missing' };
      const origin = await originOf(requireSession(decodeRun(askedParent, decodeContext).sessionId).cwd);
      return transaction<CreateChildRunResult>(() => {
        const existing = sql.childByCall.get({ parentRunId: input.parentRunId, parentCallId: input.parentCallId });
        if (existing !== undefined) {
          const run = decodeRun(existing, decodeContext);
          return { kind: 'existing', run, session: requireSession(run.sessionId) };
        }
        const parentRow = sql.selectRun.get({ id: input.parentRunId });
        if (parentRow === undefined) return { kind: 'parent_not_active', status: 'missing' };
        const parent = decodeRun(parentRow, decodeContext);
        if (isTerminal(parent.status) || parent.status === 'CANCELLING' || parent.status === UNKNOWN_VALUE || parent.cancelRequested) {
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
          model: input.model,
          bypassAllowed: parentSession.bypassAllowed ? 1 : 0,
          additionalDirectories: canonicalJson(parentSession.additionalDirectories),
          mcpServers: canonicalJson(parentSession.mcpServers),
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
          origin,
        });
        writeRun(appendPayloads(requireRun(runId), [{ type: 'user.message', text: input.input }]));
        return { kind: 'created', run: requireRun(runId), session: requireSession(sessionId) };
      });
    },

    listChildRuns: (runId) => sql.childRuns.all({ runId }).map((row) => decodeRun(row, decodeContext)),

    treeSpend: (runId) => treeSpendOf(runId, null),

    admitModelRequest: (holder, ask) =>
      transaction<Admission | LeaseLost>(() => {
        if ('settled' in holder) {
          const settled = requireRun(holder.runId);
          if (!isTerminal(settled.status)) throw new Error(`run ${holder.runId} is ${settled.status}: only its worker admits a model request while it is not ended`);
          return admitRequest(ask, treeSpendOf(holder.runId, null));
        }
        const claim = holder;
        if (fenced(claim) === undefined) return leaseLost;
        const verdict = admitRequest(ask, treeSpendOf(claim.runId, claim.runId));
        if (verdict.kind === 'admitted') sql.reserveBudget.run({ id: claim.runId, tokens: verdict.reservedTokens, nano: verdict.reservedNano });
        return verdict;
      }),

    releaseBudget: (runId) => {
      sql.reserveBudget.run({ id: runId, tokens: 0, nano: 0 });
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
          lastActivityAt: latest === undefined ? decodeSession(row, decodeContext).createdAt : readerFor('events', sessionId, latest).number('created_at'),
          hasActiveRun: readerFor('runs', sessionId, active).number('active') === 1,
        };
      }),

    maxTotalAttempts,

    pruneFidelityVerdicts: (bound) => Number(sql.pruneFidelityVerdicts.run({ bound, limit: FIDELITY_PRUNE_BATCH_ROWS }).changes),

    checkIdentity: async () => {
      let current: DatabaseFileIdentity;
      try {
        current = await fileSystem.stat(options.path);
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
        .map((row) => decodeRun(row, decodeContext))
        .filter((run) => statuses === undefined || listed(statuses, run.status)),

    getRun: (id) => {
      const row = sql.selectRun.get({ id });
      return row === undefined ? undefined : decodeRun(row, decodeContext);
    },

    claim: (workerId) => {
      const now = clock.now();
      const claim = transaction(() => {
        const candidate = sql.claimTakeover.get({ now, maxAttempts, maxTotalAttempts });
        const row = sql.claim.get({ now, maxAttempts, maxTotalAttempts, workerId, generation: options.generation ?? null, leaseExpiresAt: now + leaseMs });
        if (row === undefined) return null;
        const claimed = decodeRun(row, decodeContext);
        const takenFrom = candidate === undefined ? null : readerFor('runs', claimed.id, candidate).nullableNumber('taken_from');
        const run = takenFrom === null ? claimed : appendPayloads(claimed, [{ type: 'attempt.lost', lastLiveAt: takenFrom - leaseMs }]);
        if (takenFrom !== null) writeRun(run);
        const status: ClaimStatus = expectOneOf('runs', run.id, 'status', CLAIM_STATUSES, run.status);
        derived.repairPage(run.id, run.lastSeq);
        return { runId: run.id, sessionId: run.sessionId, workerId, leaseToken: run.leaseToken, attempt: run.attempts, status };
      });
      return claim;
    },

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

    append: (claim, events) => {
      const result = transaction(() => {
        rejectContribution(events);
        const run = fenced(claim);
        if (run === undefined) return leaseLost;
        if (events.length === 0) return { kind: 'ok', lastSeq: run.lastSeq } as const;
        const next = appendPayloads(run, events);
        writeRun(next);
        derived.repairPage(next.id, next.lastSeq);
        return { kind: 'ok', lastSeq: next.lastSeq } as const;
      });
      return result;
    },

    transition: (claim, from, to, patch, preceding = []) =>
      operate(
        { runTree: claim.runId },
        () => {
          if (!isTerminal(to)) return undefined;
          const row = sql.selectRun.get({ id: claim.runId });
          const run = row === undefined ? undefined : decodeRun(row, decodeContext);
          return run === undefined || !listed(from, run.status) ? undefined : { runId: run.id, leading: preceding, expiring: [] };
        },
        (prepared) => {
          const run = fenced(claim);
          return run === undefined ? leaseLost : moveWorker(run, from, to, patch === undefined ? {} : { patch }, preceding, prepared);
        },
      ),

    release: (claim, to, availableAt, options) =>
      derivedReads.write<RunMutationResult>({ runTree: claim.runId }, () => {
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
      derivedReads.write<RunMutationResult>({ runTree: claim.runId }, () => {
        const unknownHeld = sql.heldWithUnknownStatus.get({ runId: claim.runId, leaseToken: claim.leaseToken, workerId: claim.workerId });
        if (unknownHeld !== undefined) return releaseUntouched(decodeRun(unknownHeld, decodeContext), claim, options);
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
      derivedReads.write<RequestCancelResult>({ runTree: runId }, () => {
        const row = sql.selectRun.get({ id: runId });
        if (row === undefined) return { kind: 'not_found' };
        const run = decodeRun(row, decodeContext);
        if (isTerminal(run.status) || run.status === 'CANCELLING') return { kind: 'ok', run, changed: false };
        if (run.status === UNKNOWN_VALUE) return { kind: 'status_unknown', run };
        if (!SERVICE_TRANSITIONS[run.status].includes('CANCELLING')) throw new Error(`run ${runId} in status ${run.status} cannot be cancelled`);
        return { kind: 'ok', run: changeStatus(run, 'CANCELLING', { edges: SERVICE_TRANSITIONS }), changed: true };
      }),

    appendAsService: async (runId, expectedVersion, to, events, patch) => {
      rejectContribution(events);
      return operate(
        { runTree: runId },
        () => {
          if (to === null || !isTerminal(to)) return undefined;
          const row = sql.selectRun.get({ id: runId });
          return row === undefined || isTerminal(decodeRun(row, decodeContext).status) ? undefined : { runId, leading: events, expiring: [] };
        },
        (prepared): ServiceMutationResult => {
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
          return { kind: 'ok', run: changeStatus(run, to, change, events, prepared) };
        },
      );
    },

    readRunEvents: (runId, afterSeq, limit) =>
      fillPage(afterSeq, limit, (after, wanted) => sql.runEvents.all({ runId, after, limit: wanted }), (row) => readerFor('events', runId, row).number('seq'), decodeEvents),

    readRunEventsOfTypes: (runId, types) => journalReader.eventsOfTypes(runId, types),

    readLatestRunEventBefore: <T extends RunEventPayload['type']>(runId: string, type: T, beforeSeq: number) => {
      if (type === 'model.requested') return readLatestRequest(runId, beforeSeq) as Extract<RunEvent, { type: T }> | undefined;
      const [event] = decodeEvents(
        db.prepare('SELECT * FROM events WHERE run_id = :runId AND type = :type AND seq < :beforeSeq ORDER BY seq DESC LIMIT 1').all({ runId, type, beforeSeq }),
      );
      return event as Extract<RunEvent, { type: T }> | undefined;
    },

    readModelCallEvents: (runId) => derivedReads.read({ runId }, (view) => view.modelCallRowsOf(runId).map(decodeModelCallRecord)),

    toolCallSeq: (runId, callId) => derivedReads.read({ runId }, (view) => view.toolCallSeq(runId, callId)),

    finalTextOf: (runId) => derivedReads.read({ runId }, (view) => view.finalTextOf(runId)),

    inFlightModelRequestOf: (runId) => derivedReads.read({ runId }, (view) => view.inFlightModelRequestOf(runId)),

    startedCallsOf: (runId) => derivedReads.read({ runId }, (view) => view.startedCallsOf(runId)),

    hasNoticeCode: (runId, code) => derivedReads.read({ runId }, (view) => view.hasNoticeCode(runId, code)),

    meterRecordOf: (sessionId, key) => derivedReads.read({ sessionId }, (view) => view.meterRecordOf(sessionId, key)),

    answeringTargetsOf: (runId) => derivedReads.read({ runId }, (view) => view.answeringTargetsOf(runId)),

    recordFidelityVerdicts: (runId, cwd, reply) => transaction(() => verdicts.record(runId, cwd, reply)),

    lastTerminalRootRuns: (project, limit) => sql.lastTerminalRootRuns.all({ project, limit }).map((row) => decodeRun(row, decodeContext)),

    toolCallNames: (runId) => derivedReads.read({ runTree: runId }, (view) => view.toolCallNamesOf(runId)),

    toolOfferedNames: (runId) => {
      if (sql.hasToolOffered.get({ runId }) === undefined) throw new Error(`run ${runId} has no tool.offered record`);
      return sql.toolOfferedNames.all({ runId }).map((row) => String(row.name));
    },

    readSessionEvents: (sessionId, afterId, limit) =>
      fillPage(afterId, limit, (after, wanted) => sql.sessionEvents.all({ sessionId, after, limit: wanted }), (row) => readerFor('events', sessionId, row).number('id'), decodeKnownEvents),

    readRunEventStream: (runId, afterSeq, limit) => decodeStreamEvents(sql.runEvents.all({ runId, after: afterSeq, limit })),

    readSessionEventStream: (sessionId, afterId, limit) => decodeStreamEvents(sql.sessionEvents.all({ sessionId, after: afterId, limit })),

    readModelChanges: (sessionId, afterId) =>
      sql.modelChanges.all({ sessionId, after: afterId }).map((row) => {
        observeDecode([row]);
        const event = decodeKnownEvent(row, decodeContext);
        if (event === undefined || event.type !== 'model.changed') throw new Error(`event ${String(row['id'])} of session ${sessionId} is not a model.changed event`);
        return event;
      }),

    sessionMaxEventId: (sessionId) => {
      const row = sql.sessionMaxEventId.get({ sessionId });
      if (row === undefined) throw new Error(`could not compute the maximum event id of session ${sessionId}`);
      return readerFor('events', sessionId, row).number('max_id');
    },

    load: (runId) => readTx(db, () => loadInReadTx(runId)),

    inheritContext: async (claim, { mode, facts = store.journalFacts }) => {
      const run = requireRun(claim.runId);
      const plan = await facts.inheritPlan({ runId: run.id, mode, unasked: options.unaskedCommands });
      return plan.kind === 'ready' ? writeInheritance(claim, plan) : plan.kind === 'conflict' ? conflict(plan.reason) : plan;
    },

    requestApproval: (claim, input) =>
      derivedReads.write<RequestApprovalResult>({ runTree: claim.runId }, () => {
        const run = fenced(claim);
        if (run === undefined) return leaseLost;
        const requested = approvalOps.request({
          runId: run.id,
          callId: input.callId,
          options: input.options,
          subjectDigest: input.event.subjectDigest,
          kind: 'permission',
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
            reason: input.event.reason,
            ...(input.event.suggestedRule === undefined ? {} : { suggestedRule: input.event.suggestedRule }),
          });
          if (input.held !== undefined) {
            const { footprint, placeholder } = input.held;
            events.push({ type: 'tool.held', callId: input.callId, approvalId: requested.approval.id, reason: input.event.reason, footprint: { reads: [...footprint.reads], writes: [...footprint.writes] } });
            if (placeholder !== undefined) {
              events.push({ type: 'tool.completed', callId: input.callId, status: 'failed', output: placeholder(requested.approval.id), denial: { source: 'held', reason: input.event.reason } });
            }
          }
        }
        if (events.length > 0) writeRun(appendPayloads(run, events));
        return { kind: 'ok', approval: requested.approval };
      }),

    requestUnknownAck: async (claim, input) => {
      const [firstCallId] = input.callIds;
      if (firstCallId === undefined) throw new Error(`an unknown effect of run ${claim.runId} names at least one call`);
      return derivedReads.write<RequestApprovalResult>({ runTree: claim.runId }, () => {
        const run = fenced(claim);
        if (run === undefined) return leaseLost;
        const options = unknownEffectOptions();
        const subjectDigest = sha256Hex(canonicalJson({ unknownEffect: input.callIds }));
        const requested = approvalOps.request({ runId: run.id, callId: firstCallId, options, subjectDigest, kind: 'unknown_effect' });
        const events: RunEventPayload[] = [];
        if (requested.superseded !== undefined && approvalAnnounced(run.id, requested.superseded.id)) {
          events.push(cancelledEvent(requested.superseded, 'superseded'));
        }
        if (requested.created || !approvalAnnounced(run.id, requested.approval.id)) {
          events.push({ type: 'tool.unknown.requested', approvalId: requested.approval.id, callIds: input.callIds, options, subjectDigest });
        }
        if (events.length > 0) writeRun(appendPayloads(run, events));
        return { kind: 'ok', approval: requested.approval };
      });
    },

    resolveApproval: async (approvalId, optionId) => {
      const approval = approvalOps.store.get(approvalId);
      if (approval === undefined) return { kind: 'not_found' };
      return derivedReads.write({ runTree: approval.runId }, () => resolveInTransaction(approvalId, optionId, clock.now()));
    },

    requestElicitation: (claim, input) =>
      derivedReads.write<RequestApprovalResult>({ runTree: claim.runId }, () => {
        const run = fenced(claim);
        if (run === undefined) return leaseLost;
        const requested = approvalOps.request({
          runId: run.id,
          callId: input.callId,
          options: [],
          subjectDigest: sha256Hex(canonicalJson({ server: input.server, requests: input.requests })),
          kind: 'elicitation',
          elicitation: { server: input.server, requests: input.requests, expiresAt: input.expiresAt },
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

    resolveElicitation: async (elicitationId, responses, notices = []) => {
      const now = clock.now();
      const elicitation = approvalOps.store.get(elicitationId);
      if (elicitation === undefined) return { kind: 'not_found' };
      return operate(
        { runTree: elicitation.runId },
        () => lateInputNeed(elicitationId, now),
        (prepared) => resolveElicitationInTransaction(elicitationId, responses, notices, now, prepared),
      );
    },

    elicitationView: async (elicitationId) => {
      const approval = approvalOps.store.get(elicitationId);
      return approval === undefined || approval.kind !== 'elicitation' ? undefined : derivedReads.read({ runId: approval.runId }, () => elicitationViewOf(approval));
    },

    pendingElicitationViews: (runId) => derivedReads.read({ runId }, () => approvalOps.store.listPending(runId).filter((approval) => approval.kind === 'elicitation').map(elicitationViewOf)),

    hasActiveRun: () => {
      const row = sql.anyActiveRunExists.get({});
      if (row === undefined) throw new Error('could not compute whether any run is active');
      return readerFor('runs', 'any', row).number('active') === 1;
    },

    terminalRunIdsWithCheckpoint: () => sql.terminalRunIdsWithCheckpoint.all({}).map((row) => readerFor('runs', 'terminal', row).string('id')),

    expireApprovals: async (nowMs, onError) => {
      const stopped: string[] = [];
      for (const row of sql.dueWaitingRuns.all({ nowMs })) {
        const runId = readerFor('runs', 'due', row).string('id');
        try {
          const didStop = await operate(
            { runTree: runId },
            () => stopNeed(runId, nowMs),
            (prepared) => stopWaitingRun(requireRun(runId), nowMs, prepared),
          );
          if (didStop) stopped.push(runId);
        } catch (error) {
          onError(error, runId);
        }
      }
      return stopped;
    },

    finishCancelled: async (onError) => {
      const finished: string[] = [];
      const now = clock.now();
      for (const row of sql.listSweeperOwned.all({ now })) {
        const runId = decodeRun(row, decodeContext).id;
        try {
          const didFinish = await operate(
            { runTree: runId },
            () => (sql.sweeperOwnedById.get({ id: runId, now }) === undefined ? undefined : { runId, leading: [], expiring: [] }),
            (prepared) => {
              const current = sql.sweeperOwnedById.get({ id: runId, now });
              if (current === undefined) return false;
              changeStatus(decodeRun(current, decodeContext), 'CANCELLED', { edges: WORKER_TRANSITIONS }, [], prepared);
              return true;
            },
          );
          if (didFinish) finished.push(runId);
        } catch (error) {
          onError(error, runId);
        }
      }
      return finished;
    },

    deadLetterExhausted: async (onError) => {
      const ended: string[] = [];
      const now = clock.now();
      const exhausted = { now, maxAttempts, maxTotalAttempts };
      for (const row of sql.listExhausted.all(exhausted)) {
        const runId = decodeRun(row, decodeContext).id;
        try {
          const didEnd = await operate(
            { runTree: runId },
            () => (sql.exhaustedById.get({ id: runId, ...exhausted }) === undefined ? undefined : { runId, leading: [], expiring: [] }),
            (prepared) => {
              const current = sql.exhaustedById.get({ id: runId, ...exhausted });
              if (current === undefined) return false;
              deadLetter(decodeRun(current, decodeContext), prepared);
              return true;
            },
          );
          if (didEnd) ended.push(runId);
        } catch (error) {
          onError(error, runId);
        }
      }
      return ended;
    },

    approvalView: async (approvalId) => {
      const approval = approvalOps.store.get(approvalId);
      return approval === undefined || (approval.kind !== 'permission' && approval.kind !== 'unknown_effect') ? undefined : derivedReads.read({ runId: approval.runId }, () => viewOf(approval));
    },

    pendingApprovalViews: (runId) => derivedReads.read({ runId }, () => approvalOps.store.listPending(runId).filter((approval) => approval.kind === 'permission' || approval.kind === 'unknown_effect').map(viewOf)),

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
        const encoded = canonicalJson(encodeRunState(state));
        onEncode?.('snapshot', Buffer.byteLength(encoded));
        sql.upsertSnapshot.run({ runId: run.id, seq, state: encoded, createdAt: clock.now() });
        sql.pruneSnapshots.run({ runId: run.id, seq });
        return { kind: 'ok' } as const;
      }),

    idempotency: createIdempotencyStore(db, clock, (fence) => fenced(fence) !== undefined, decodeContext),
    approvals: approvalOps.store,
    blobs,
    trust,
    ruleVerdicts,
    inbox,
    userShell,
    memories: { ...memories, save: (input) => derivedReads.write({ runId: input.runId }, () => memories.save(input)) },
    sessionTouched: {
      after: (sessionId, afterEventId, limit, afterPath) => derivedReads.read({ sessionId }, (view) => view.touchedAfter(sessionId, afterEventId, limit, afterPath)),
      newest: (sessionId, limit) => derivedReads.read({ sessionId }, (view) => view.touchedNewest(sessionId, limit)),
    },
    reflection,
    contextCharges,
    guidelines: createGuidelineStore(db, clock),
    governing,
    search: createSearchStore(db, decodeContext, derivedReads),
    runFacts,
    permissionReviews: createPermissionReviewsStore(db, decodeContext, runFacts.calls),

    journalFacts: {
      inheritPlan: async (request, signal) => journalPreparer(preparer, 'inheritance plan').inheritPlan(request, signal),
      inheritedWindow: async (request, signal) => journalPreparer(preparer, 'inherited window').inheritedWindow(request, signal),
      verdict: async (request, signal) => journalPreparer(preparer, 'verdict').verdict(request, signal),
      evidence: async (request, signal) => journalPreparer(preparer, 'evidence').evidence(request, signal),
      reflectionInput: async (request, signal) => journalPreparer(preparer, 'reflection input').reflectionInput(request, signal),
      fidelity: async (request, signal) => journalPreparer(preparer, 'fidelity check').fidelity(request, signal),
      report: async (request, signal) => journalPreparer(preparer, 'report').report(request, signal),
    },

    dataVersion: () => {
      const row = sql.dataVersion.get();
      if (row === undefined) throw new Error('PRAGMA data_version returned no row');
      return readerFor('pragma', 'data_version', row).number('data_version');
    },

    close: () => {
      lifetime.abort(new Error('the store is closed'));
      if (db.isOpen) db.close();
    },
  };
  return store;
};

