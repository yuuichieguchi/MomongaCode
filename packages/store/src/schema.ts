import type { Migration } from '@momonga/foundation';

const INITIAL_SCHEMA = `
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  cwd TEXT NOT NULL,
  env_json TEXT NOT NULL,
  permission_mode TEXT NOT NULL CHECK (permission_mode IN ('default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions')),
  model_alias TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX sessions_by_cwd ON sessions (cwd, created_at);

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions (id),
  ordinal INTEGER NOT NULL,
  idempotency_key TEXT,
  status TEXT NOT NULL CHECK (
    status IN ('QUEUED', 'RUNNING', 'WAITING_TOOL', 'WAITING_HUMAN', 'CANCELLING', 'COMPLETED', 'STOPPED', 'FAILED', 'CANCELLED')
  ),
  stop_reason TEXT CHECK (
    stop_reason IS NULL OR stop_reason IN ('max_steps', 'budget', 'max_tokens', 'timeout', 'loop', 'approval_timeout', 'refusal')
  ),
  version INTEGER NOT NULL,
  lease_owner TEXT,
  lease_token INTEGER NOT NULL,
  lease_expires_at INTEGER,
  available_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL,
  failed_attempts INTEGER NOT NULL,
  cancel_requested INTEGER NOT NULL CHECK (cancel_requested IN (0, 1)),
  deadline_at INTEGER NOT NULL,
  limits_json TEXT NOT NULL,
  usage_json TEXT NOT NULL,
  step INTEGER NOT NULL,
  last_seq INTEGER NOT NULL,
  pins TEXT NOT NULL,
  error_json TEXT,
  dead_letter INTEGER NOT NULL CHECK (dead_letter IN (0, 1)),
  created_at INTEGER NOT NULL,
  UNIQUE (session_id, ordinal)
);
CREATE UNIQUE INDEX runs_by_session_idempotency_key ON runs (session_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX runs_by_status_availability ON runs (status, available_at, created_at);

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES runs (id),
  session_id TEXT NOT NULL REFERENCES sessions (id),
  seq INTEGER NOT NULL,
  step INTEGER NOT NULL,
  lease_token INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  UNIQUE (run_id, seq)
);
CREATE INDEX events_by_session ON events (session_id, id);
CREATE TRIGGER events_reject_update BEFORE UPDATE ON events BEGIN
  SELECT RAISE(ABORT, 'events are append-only: UPDATE is not allowed');
END;
CREATE TRIGGER events_reject_delete BEFORE DELETE ON events BEGIN
  SELECT RAISE(ABORT, 'events are append-only: DELETE is not allowed');
END;

CREATE TABLE snapshots (
  run_id TEXT NOT NULL REFERENCES runs (id),
  seq INTEGER NOT NULL,
  state_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (run_id, seq)
);

CREATE TABLE idempotency (
  key TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('PENDING', 'COMPLETED', 'UNKNOWN')),
  meta_json TEXT NOT NULL,
  result_json TEXT,
  pgid INTEGER,
  started_at INTEGER,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idempotency_by_expiry ON idempotency (expires_at);

CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs (id),
  call_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'resolved')),
  options_json TEXT NOT NULL,
  option_id TEXT,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER,
  UNIQUE (run_id, call_id)
);
CREATE INDEX approvals_by_expiry ON approvals (status, expires_at);

CREATE TABLE blobs (
  sha256 TEXT PRIMARY KEY,
  byte_length INTEGER NOT NULL,
  line_count INTEGER NOT NULL,
  media_type TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE trust (
  path TEXT PRIMARY KEY,
  decision TEXT NOT NULL CHECK (decision IN ('trusted', 'untrusted')),
  decided_at INTEGER NOT NULL
);
`;

const RENEWABLE_APPROVALS = `
CREATE TABLE approvals_renewable (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs (id),
  call_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'resolved', 'superseded')),
  options_json TEXT NOT NULL,
  option_id TEXT,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER,
  subject_digest TEXT
);
INSERT INTO approvals_renewable (id, run_id, call_id, status, options_json, option_id, expires_at, created_at, resolved_at)
  SELECT id, run_id, call_id, status, options_json, option_id, expires_at, created_at, resolved_at FROM approvals;
DROP TABLE approvals;
ALTER TABLE approvals_renewable RENAME TO approvals;
CREATE INDEX approvals_by_expiry ON approvals (status, expires_at);
CREATE INDEX approvals_by_call ON approvals (run_id, call_id, created_at);
CREATE UNIQUE INDEX approvals_one_pending_per_call ON approvals (run_id, call_id) WHERE status = 'pending';
`;

const SESSION_SCOPED_EVENTS_AND_APPROVAL_LIFECYCLE = `
CREATE TABLE events_session_scoped (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT REFERENCES runs (id),
  session_id TEXT NOT NULL REFERENCES sessions (id),
  seq INTEGER,
  step INTEGER,
  lease_token INTEGER,
  created_at INTEGER NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  UNIQUE (run_id, seq),
  CHECK ((run_id IS NULL) = (seq IS NULL) AND (seq IS NULL) = (step IS NULL) AND (step IS NULL) = (lease_token IS NULL))
);
INSERT INTO events_session_scoped (id, run_id, session_id, seq, step, lease_token, created_at, type, payload_json)
  SELECT id, run_id, session_id, seq, step, lease_token, created_at, type, payload_json FROM events;
DROP TABLE events;
ALTER TABLE events_session_scoped RENAME TO events;
CREATE INDEX events_by_session ON events (session_id, id);
CREATE TRIGGER events_reject_update BEFORE UPDATE ON events BEGIN
  SELECT RAISE(ABORT, 'events are append-only: UPDATE is not allowed');
END;
CREATE TRIGGER events_reject_delete BEFORE DELETE ON events BEGIN
  SELECT RAISE(ABORT, 'events are append-only: DELETE is not allowed');
END;

CREATE TABLE approvals_lifecycle (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs (id),
  call_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'resolved', 'superseded', 'expired', 'withdrawn')),
  options_json TEXT NOT NULL,
  option_id TEXT,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER,
  subject_digest TEXT
);
INSERT INTO approvals_lifecycle (id, run_id, call_id, status, options_json, option_id, expires_at, created_at, resolved_at, subject_digest)
  SELECT id, run_id, call_id, status, options_json, option_id, expires_at, created_at, resolved_at, subject_digest FROM approvals;
DROP TABLE approvals;
ALTER TABLE approvals_lifecycle RENAME TO approvals;
CREATE INDEX approvals_by_expiry ON approvals (status, expires_at);
CREATE INDEX approvals_by_call ON approvals (run_id, call_id, created_at);
CREATE UNIQUE INDEX approvals_one_pending_per_call ON approvals (run_id, call_id) WHERE status = 'pending';

ALTER TABLE runs ADD COLUMN request_digest TEXT;
ALTER TABLE runs ADD COLUMN previous_run_id TEXT REFERENCES runs (id);
ALTER TABLE sessions ADD COLUMN bypass_allowed INTEGER NOT NULL DEFAULT 0 CHECK (bypass_allowed IN (0, 1));
`;

const SESSION_ADDITIONAL_DIRECTORIES = `
ALTER TABLE sessions ADD COLUMN additional_directories_json TEXT NOT NULL DEFAULT '[]';
`;

const RUN_HISTORY_MODE = `
ALTER TABLE runs ADD COLUMN history_mode TEXT NOT NULL DEFAULT 'fresh' CHECK (history_mode IN ('inherit', 'fresh'));
UPDATE runs SET history_mode = 'inherit' WHERE previous_run_id IS NOT NULL AND status = 'QUEUED' AND attempts = 0;
`;

const SUBAGENT_RUNS_AND_BACKGROUND_JOBS = `
ALTER TABLE runs ADD COLUMN parent_run_id TEXT REFERENCES runs (id);
ALTER TABLE runs ADD COLUMN parent_call_id TEXT;
CREATE UNIQUE INDEX runs_by_parent_call ON runs (parent_run_id, parent_call_id) WHERE parent_run_id IS NOT NULL;
CREATE INDEX runs_by_parent ON runs (parent_run_id) WHERE parent_run_id IS NOT NULL;

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  idem_key TEXT NOT NULL UNIQUE,
  session_id TEXT NOT NULL REFERENCES sessions (id),
  run_id TEXT NOT NULL REFERENCES runs (id),
  call_id TEXT NOT NULL,
  command TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'exited', 'killed', 'unknown')),
  pgid INTEGER,
  exit_code INTEGER,
  signal TEXT,
  output_handle TEXT,
  output_start INTEGER NOT NULL,
  output_total INTEGER NOT NULL,
  read_offset INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER
);
CREATE INDEX jobs_by_session ON jobs (session_id, started_at);
CREATE INDEX jobs_by_status ON jobs (status);
`;

export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: 'initial schema', sql: INITIAL_SCHEMA },
  { version: 2, name: 'allow a new approval once the previous one for the call is resolved or superseded, and bind approvals to a subject digest', sql: RENEWABLE_APPROVALS },
  {
    version: 3,
    name: 'allow session-scoped events, add the expired and withdrawn approval statuses, record the request digest and previous run, and mark sessions that may use bypass',
    sql: SESSION_SCOPED_EVENTS_AND_APPROVAL_LIFECYCLE,
  },
  { version: 4, name: 'snapshot the additional directories of a session', sql: SESSION_ADDITIONAL_DIRECTORIES },
  { version: 5, name: 'record whether a run inherits the history of its predecessor', sql: RUN_HISTORY_MODE },
  { version: 6, name: 'link subagent runs to the run and tool call that spawned them, and record background jobs', sql: SUBAGENT_RUNS_AND_BACKGROUND_JOBS },
];
