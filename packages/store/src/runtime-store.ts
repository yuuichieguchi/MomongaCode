import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { canonicalJson, immediateTx, migrate, openDatabase, readTx, uuidv7 } from '@momonga/foundation';
import { TERMINAL_STATUSES } from '@momonga/protocol';
import type { RunEventPayload, RunStatus } from '@momonga/protocol';
import { createApprovalStore } from './approvals.ts';
import { createBlobStore, prepareBlobDirectory } from './blobs.ts';
import { decodeEvent, decodeRun, decodeRunState, decodeSession, encodeRunState } from './codec.ts';
import { createIdempotencyStore } from './idempotency.ts';
import { corrupt, expectOneOf, readerFor } from './rows.ts';
import type { Row } from './rows.ts';
import { MIGRATIONS } from './schema.ts';
import { createTrustStore } from './trust.ts';
import type {
  Claim,
  ClaimStatus,
  Conflict,
  HeartbeatResult,
  LeaseLost,
  LoadedRun,
  Run,
  RequestApprovalResult,
  RunMutationResult,
  RuntimeStore,
  RuntimeStoreOptions,
  ServiceMutationResult,
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

const isTerminal = (status: RunStatus): boolean => TERMINAL_STATUSES.some((terminal) => terminal === status);

const CLAIMABLE = `
  (
    (r.status = 'QUEUED' AND r.available_at <= :now)
    OR (r.status IN ('RUNNING', 'CANCELLING') AND (r.lease_expires_at IS NULL OR r.lease_expires_at <= :now))
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
    id, session_id, ordinal, idempotency_key, status, version, lease_token, available_at, attempts, failed_attempts,
    cancel_requested, deadline_at, limits_json, usage_json, step, last_seq, pins, dead_letter, created_at
  ) VALUES (
    :id, :sessionId, :ordinal, :idempotencyKey, 'QUEUED', 0, 0, :availableAt, 0, 0,
    0, :deadlineAt, :limits, :usage, 0, 0, :pins, 0, :createdAt
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
    `INSERT INTO sessions (id, cwd, env_json, permission_mode, model_alias, created_at)
     VALUES (:id, :cwd, :env, :permissionMode, :modelAlias, :createdAt)`,
  ),
  selectSession: db.prepare('SELECT * FROM sessions WHERE id = :id'),
  listSessions: db.prepare('SELECT * FROM sessions ORDER BY created_at, rowid'),
  listSessionsByCwd: db.prepare('SELECT * FROM sessions WHERE cwd = :cwd ORDER BY created_at, rowid'),
  selectRun: db.prepare('SELECT * FROM runs WHERE id = :id'),
  selectRunByKey: db.prepare('SELECT * FROM runs WHERE session_id = :sessionId AND idempotency_key = :key'),
  nextOrdinal: db.prepare('SELECT COALESCE(MAX(ordinal), 0) + 1 AS next FROM runs WHERE session_id = :sessionId'),
  insertRun: db.prepare(RUN_INSERT_SQL),
  writeRun: db.prepare(RUN_WRITE_SQL),
  insertEvent: db.prepare(
    `INSERT INTO events (run_id, session_id, seq, step, lease_token, created_at, type, payload_json)
     VALUES (:runId, :sessionId, :seq, :step, :leaseToken, :createdAt, :type, :payload)`,
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
  const { clock, leaseMs, maxAttempts, maxTotalAttempts } = options;
  const db = openDatabase(options.path);
  let statements: Statements;
  let blobDirectory: string;
  try {
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
      sql.insertEvent.run({
        runId: run.id,
        sessionId: run.sessionId,
        seq,
        step,
        leaseToken: run.leaseToken,
        createdAt,
        type: payload.type,
        payload: canonicalJson(payload),
      });
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

  const changeStatus = (run: Run, to: RunStatus, change: StatusChange, leadingEvents: readonly RunEventPayload[] = []): Run => {
    if (!change.edges[run.status].includes(to)) throw new Error(`run ${run.id} has no permitted edge ${run.status} -> ${to}`);
    const patch = change.patch ?? {};
    const reason = patch.stopReason ?? patch.error?.code;
    const statusEvent: RunEventPayload = { type: 'run.status', from: run.status, to, ...(reason === undefined ? {} : { reason }) };
    const appended = appendPayloads(run, [...leadingEvents, statusEvent]);
    const keepsLease = to === 'RUNNING' || to === 'CANCELLING';
    const wakesNow = to === 'QUEUED' || (to === 'CANCELLING' && run.leaseOwner === null);
    const next: Run = {
      ...appended,
      status: to,
      version: run.version + 1,
      leaseOwner: keepsLease ? run.leaseOwner : null,
      leaseExpiresAt: keepsLease ? run.leaseExpiresAt : null,
      availableAt: change.availableAt ?? (wakesNow ? clock.now() : run.availableAt),
      cancelRequested: run.cancelRequested || to === 'CANCELLING' || to === 'CANCELLED',
      deadLetter: change.deadLetter ?? run.deadLetter,
      failedAttempts: change.resetFailures === true ? 0 : run.failedAttempts,
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

  const workerTransition = (
    claim: Claim,
    from: readonly RunStatus[],
    to: RunStatus,
    change: Omit<StatusChange, 'edges' | 'resetFailures'>,
  ): RunMutationResult =>
    immediateTx<RunMutationResult>(db, () => {
      const run = fenced(claim);
      if (run === undefined) return leaseLost;
      if (!from.includes(run.status)) {
        return conflict(`run ${run.id} is ${run.status}, expected one of ${from.join(', ')}`);
      }
      if (!WORKER_TRANSITIONS[run.status].includes(to)) return conflict(`run ${run.id} cannot move from ${run.status} to ${to}`);
      return { kind: 'ok', run: changeStatus(run, to, { ...change, edges: WORKER_TRANSITIONS, resetFailures: true }) };
    });

  const store: RuntimeStore = {
    createSession: (input) =>
      immediateTx(db, () => {
        const id = uuidv7(clock);
        sql.insertSession.run({
          id,
          cwd: input.cwd,
          env: canonicalJson(input.env),
          permissionMode: input.permissionMode,
          modelAlias: input.modelAlias,
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

    createRunAndEnqueue: (sessionId, input) =>
      immediateTx(db, () => {
        if (sql.selectSession.get({ id: sessionId }) === undefined) throw new Error(`unknown session ${sessionId}`);
        if (input.idempotencyKey !== undefined) {
          const existing = sql.selectRunByKey.get({ sessionId, key: input.idempotencyKey });
          if (existing !== undefined) return decodeRun(existing);
        }
        const ordinalRow = sql.nextOrdinal.get({ sessionId });
        if (ordinalRow === undefined) throw new Error(`could not compute the next run ordinal for session ${sessionId}`);
        const ordinal = readerFor('runs', sessionId, ordinalRow).number('next');
        const id = uuidv7(clock);
        const now = clock.now();
        sql.insertRun.run({
          id,
          sessionId,
          ordinal,
          idempotencyKey: input.idempotencyKey ?? null,
          availableAt: now,
          deadlineAt: input.deadlineAt,
          limits: canonicalJson(input.limits),
          usage: canonicalJson({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }),
          pins: canonicalJson(input.pins),
          createdAt: now,
        });
        const inserted = appendPayloads(requireRun(id), [{ type: 'user.message', text: input.input }]);
        writeRun(inserted);
        return requireRun(id);
      }),

    getRun: (id) => {
      const row = sql.selectRun.get({ id });
      return row === undefined ? undefined : decodeRun(row);
    },

    claim: (workerId) =>
      immediateTx(db, () => {
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
      immediateTx<HeartbeatResult>(db, () => {
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
      immediateTx(db, () => {
        const run = fenced(claim);
        if (run === undefined) return leaseLost;
        if (events.length === 0) return { kind: 'ok', lastSeq: run.lastSeq } as const;
        const next = appendPayloads(run, events);
        writeRun(next);
        return { kind: 'ok', lastSeq: next.lastSeq } as const;
      }),

    transition: (claim, from, to, patch) => workerTransition(claim, from, to, patch === undefined ? {} : { patch }),

    release: (claim, to, availableAt) =>
      workerTransition(claim, CLAIM_STATUSES, to, availableAt === undefined ? {} : { availableAt }),

    requestCancel: (runId) =>
      immediateTx(db, () => {
        const run = requireRun(runId);
        if (isTerminal(run.status) || run.status === 'CANCELLING') return run;
        const to: RunStatus = run.status === 'QUEUED' || run.status === 'WAITING_HUMAN' ? 'CANCELLED' : 'CANCELLING';
        if (!SERVICE_TRANSITIONS[run.status].includes(to)) throw new Error(`run ${runId} in status ${run.status} cannot be cancelled`);
        return changeStatus(run, to, { edges: SERVICE_TRANSITIONS });
      }),

    appendAsService: (runId, expectedVersion, to, events, patch) =>
      immediateTx<ServiceMutationResult>(db, () => {
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

    readRunEvents: (runId, afterSeq, limit) => sql.runEvents.all({ runId, after: afterSeq, limit }).map(decodeEvent),

    readSessionEvents: (sessionId, afterId, limit) =>
      sql.sessionEvents.all({ sessionId, after: afterId, limit }).map(decodeEvent),

    load: (runId) =>
      readTx(db, (): LoadedRun => {
        requireRun(runId);
        const row: Row | undefined = sql.latestSnapshot.get({ runId });
        if (row === undefined) return { tail: sql.runEvents.all({ runId, after: 0, limit: -1 }).map(decodeEvent) };
        const identity = `${runId}@${String(row['seq'])}`;
        const reader = readerFor('snapshots', identity, row);
        const seq = reader.number('seq');
        const state = decodeRunState(identity, reader.json('state_json'));
        if (state === undefined) return { tail: sql.runEvents.all({ runId, after: 0, limit: -1 }).map(decodeEvent) };
        if (state.runId !== runId) throw corrupt('snapshots', identity, `state belongs to run ${state.runId}`);
        return { snapshot: { seq, state }, tail: sql.runEvents.all({ runId, after: seq, limit: -1 }).map(decodeEvent) };
      }),

    requestApproval: (claim, input) =>
      immediateTx<RequestApprovalResult>(db, () => {
        const run = fenced(claim);
        if (run === undefined) return leaseLost;
        const created = approvalOps.createWithinTransaction({
          runId: run.id,
          callId: input.callId,
          options: input.options,
          expiresAt: input.expiresAt,
          renewal: true,
          subjectDigest: input.event.subjectDigest,
        }, true);
        if (created.kind === 'conflict') return created;
        if (created.created || !sql.approvalRequested.get({ runId: run.id, approvalId: created.approval.id })) {
          const event: RunEventPayload = {
            type: 'tool.permission.requested',
            approvalId: created.approval.id,
            callId: input.callId,
            options: input.options,
            subjectDigest: input.event.subjectDigest,
            ...(input.event.suggestedRule === undefined ? {} : { suggestedRule: input.event.suggestedRule }),
          };
          writeRun(appendPayloads(run, [event]));
        }
        return { kind: 'ok', approval: created.approval };
      }),

    writeSnapshot: (claim, seq, state) =>
      immediateTx(db, () => {
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
    trust: createTrustStore(db, clock),

    close: () => {
      if (db.isOpen) db.close();
    },
  };
  return store;
};

