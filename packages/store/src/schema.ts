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

const LONG_TERM_MEMORIES = `
CREATE TABLE memories (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('user', 'project')),
  project TEXT,
  text TEXT NOT NULL,
  source_session_id TEXT NOT NULL,
  source_run_id TEXT NOT NULL,
  source_step INTEGER NOT NULL,
  source_call_id TEXT NOT NULL,
  source_seq INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL,
  CHECK ((scope = 'project') = (project IS NOT NULL)),
  UNIQUE (source_run_id, source_call_id)
);
CREATE INDEX memories_by_project ON memories (project);
CREATE INDEX memories_by_recency ON memories (last_used_at DESC, created_at DESC);
`;

const ELICITATION_APPROVALS = `
ALTER TABLE approvals ADD COLUMN kind TEXT NOT NULL DEFAULT 'permission' CHECK (kind IN ('permission', 'elicitation'));
ALTER TABLE approvals ADD COLUMN server TEXT;
ALTER TABLE approvals ADD COLUMN requests_json TEXT;
ALTER TABLE approvals ADD COLUMN responses_json TEXT;
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

const SESSION_MCP_SERVERS = `
ALTER TABLE sessions ADD COLUMN mcp_servers_json TEXT NOT NULL DEFAULT '{}';
`;

const MEMORY_TRUST_ORIGIN = `
ALTER TABLE memories ADD COLUMN origin TEXT NOT NULL DEFAULT 'untrusted' CHECK (origin IN ('trusted', 'untrusted'));
UPDATE memories SET origin = 'trusted'
WHERE scope = 'project'
   OR (
     SELECT t.decision FROM sessions s JOIN trust t ON (s.cwd = t.path OR substr(s.cwd, 1, length(t.path) + 1) = t.path || '/')
     WHERE s.id = memories.source_session_id
     ORDER BY length(t.path) DESC LIMIT 1
   ) = 'trusted';
`;

const JOB_READ_REPLAY = `
ALTER TABLE jobs ADD COLUMN read_call TEXT;
ALTER TABLE jobs ADD COLUMN read_before INTEGER;
`;

const IDEMPOTENCY_LEASE_TOKEN = `
ALTER TABLE idempotency ADD COLUMN lease_token INTEGER;
`;

const REFLECTION_DROPPED_CANDIDATES = `
ALTER TABLE reflection_jobs ADD COLUMN dropped_json TEXT;
`;

const CONTEXT_CHARGE_DETAIL = `
ALTER TABLE context_charges ADD COLUMN detail_json TEXT;
CREATE UNIQUE INDEX context_charges_by_response ON context_charges (json_extract(detail_json, '$.responseId'))
  WHERE json_extract(detail_json, '$.responseId') IS NOT NULL;
`;

const EVIDENCE_BASED_CONTEXT = `
CREATE TABLE memories_rebuilt (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('user', 'project')),
  project TEXT,
  text TEXT NOT NULL,
  source_session_id TEXT,
  source_run_id TEXT,
  source_step INTEGER,
  source_call_id TEXT,
  source_seq INTEGER,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL,
  origin TEXT NOT NULL DEFAULT 'untrusted' CHECK (origin IN ('trusted', 'untrusted')),
  kind TEXT NOT NULL DEFAULT 'fact' CHECK (kind IN ('fact', 'episode', 'procedure')),
  duplicate_of TEXT,
  state TEXT NOT NULL DEFAULT 'active' CHECK (
    state IN ('active', 'candidate', 'archived', 'duplicate', 'rejected') AND ((state = 'duplicate') = (duplicate_of IS NOT NULL))
  ),
  supersedes_json TEXT NOT NULL DEFAULT '[]',
  retired_at INTEGER,
  contributed_at INTEGER,
  source_kind TEXT NOT NULL DEFAULT 'tool',
  CHECK ((scope = 'project') = (project IS NOT NULL)),
  CHECK (
    (
      source_kind = 'command'
      AND source_session_id IS NULL AND source_run_id IS NULL AND source_step IS NULL AND source_call_id IS NULL AND source_seq IS NULL
    )
    OR (
      source_kind IN ('tool', 'reflection')
      AND source_session_id IS NOT NULL AND source_run_id IS NOT NULL AND source_step IS NOT NULL AND source_call_id IS NOT NULL AND source_seq IS NOT NULL
      AND ((source_kind = 'reflection') = (source_call_id GLOB 'reflection:[0-9]*' AND substr(source_call_id, 12) NOT GLOB '*[^0-9]*'))
    )
  ),
  UNIQUE (source_run_id, source_call_id)
);
INSERT INTO memories_rebuilt (
  id, scope, project, text, source_session_id, source_run_id, source_step, source_call_id, source_seq, created_at, last_used_at, origin
)
SELECT id, scope, project, text, source_session_id, source_run_id, source_step, source_call_id, source_seq, created_at, last_used_at, origin FROM memories;
DROP TABLE memories;
ALTER TABLE memories_rebuilt RENAME TO memories;
CREATE INDEX memories_by_project ON memories (project);
CREATE INDEX memories_by_recency ON memories (last_used_at DESC, created_at DESC);
CREATE INDEX memories_by_state ON memories (state, project);
CREATE INDEX memories_by_created ON memories (created_at, id);

CREATE TRIGGER memories_reject_replace BEFORE INSERT ON memories WHEN EXISTS (
  SELECT 1 FROM memories WHERE id = NEW.id OR (source_run_id = NEW.source_run_id AND source_call_id = NEW.source_call_id)
) BEGIN
  SELECT RAISE(ABORT, 'memories are not replaced: the row exists');
END;

CREATE TRIGGER memories_retired_at_write_once BEFORE UPDATE OF retired_at ON memories WHEN OLD.retired_at IS NOT NULL BEGIN
  SELECT RAISE(ABORT, 'memories.retired_at is write-once');
END;

CREATE VIRTUAL TABLE memories_index USING fts5(memory_id UNINDEXED, text, tokenize = 'trigram');
INSERT INTO memories_index (memory_id, text) SELECT id, text FROM memories;
CREATE TRIGGER memories_index_insert AFTER INSERT ON memories BEGIN
  INSERT INTO memories_index (memory_id, text) VALUES (NEW.id, NEW.text);
END;
CREATE TRIGGER memories_index_delete AFTER DELETE ON memories BEGIN
  DELETE FROM memories_index WHERE memory_id = OLD.id;
END;
CREATE TRIGGER memories_index_update AFTER UPDATE OF text ON memories BEGIN
  DELETE FROM memories_index WHERE memory_id = OLD.id;
  INSERT INTO memories_index (memory_id, text) VALUES (NEW.id, NEW.text);
END;

CREATE TABLE memory_replacements (
  replaced_id TEXT NOT NULL,
  successor_id TEXT NOT NULL REFERENCES memories (id) ON DELETE CASCADE,
  PRIMARY KEY (replaced_id, successor_id)
) WITHOUT ROWID;
CREATE INDEX memory_replacements_by_successor ON memory_replacements (successor_id);
CREATE TRIGGER memories_replacements_insert AFTER INSERT ON memories BEGIN
  INSERT OR IGNORE INTO memory_replacements (replaced_id, successor_id) SELECT value, NEW.id FROM json_each(NEW.supersedes_json);
END;
CREATE TRIGGER memories_replacements_update AFTER UPDATE OF supersedes_json ON memories BEGIN
  DELETE FROM memory_replacements WHERE successor_id = OLD.id;
  INSERT OR IGNORE INTO memory_replacements (replaced_id, successor_id) SELECT value, NEW.id FROM json_each(NEW.supersedes_json);
END;

CREATE TABLE memory_evidence (
  memory_id TEXT NOT NULL REFERENCES memories (id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('file', 'commit', 'check')),
  project TEXT,
  path TEXT,
  sha256 TEXT,
  sha TEXT,
  run_id TEXT,
  call_id TEXT,
  seq INTEGER,
  command TEXT,
  exit_code INTEGER,
  PRIMARY KEY (memory_id, ordinal),
  CHECK (
    kind <> 'file'
    OR (project IS NOT NULL AND path IS NOT NULL AND sha256 IS NOT NULL
      AND sha IS NULL AND run_id IS NULL AND call_id IS NULL AND seq IS NULL AND command IS NULL AND exit_code IS NULL)
  ),
  CHECK (
    kind <> 'commit'
    OR (sha IS NOT NULL
      AND project IS NULL AND path IS NULL AND sha256 IS NULL AND run_id IS NULL AND call_id IS NULL AND seq IS NULL AND command IS NULL AND exit_code IS NULL)
  ),
  CHECK (
    kind <> 'check'
    OR (run_id IS NOT NULL AND call_id IS NOT NULL AND seq IS NOT NULL AND command IS NOT NULL AND exit_code IS NOT NULL
      AND project IS NULL AND path IS NULL AND sha256 IS NULL AND sha IS NULL)
  )
);

CREATE TABLE governing_facts (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('constraint', 'preference', 'commitment', 'role', 'identity')),
  target TEXT NOT NULL,
  text TEXT NOT NULL,
  scope_level TEXT NOT NULL CHECK (scope_level IN ('user', 'project')),
  project TEXT,
  paths_json TEXT NOT NULL,
  valid_from INTEGER NOT NULL,
  valid_until INTEGER,
  retired_at INTEGER,
  supersedes_json TEXT NOT NULL,
  enforcement_behavior TEXT CHECK (enforcement_behavior IS NULL OR enforcement_behavior IN ('deny', 'ask')),
  enforcement_rule TEXT,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('command', 'proposal')),
  source_at INTEGER,
  source_session_id TEXT,
  source_run_id TEXT,
  source_seq INTEGER,
  source_call_id TEXT,
  CHECK ((scope_level = 'project') = (project IS NOT NULL)),
  CHECK (scope_level = 'project' OR paths_json = '[]'),
  CHECK ((enforcement_behavior IS NULL) = (enforcement_rule IS NULL)),
  CHECK (
    source_kind <> 'command'
    OR (source_at IS NOT NULL AND source_session_id IS NULL AND source_run_id IS NULL AND source_seq IS NULL AND source_call_id IS NULL)
  ),
  CHECK (
    source_kind <> 'proposal'
    OR (source_at IS NULL AND source_session_id IS NOT NULL AND source_run_id IS NOT NULL AND source_seq IS NOT NULL AND source_call_id IS NOT NULL)
  )
);
CREATE INDEX governing_facts_by_project ON governing_facts (project);
CREATE UNIQUE INDEX governing_facts_by_source ON governing_facts (source_run_id, source_call_id) WHERE source_kind = 'proposal';
CREATE TRIGGER governing_facts_reject_replace BEFORE INSERT ON governing_facts WHEN EXISTS (SELECT 1 FROM governing_facts WHERE id = NEW.id) BEGIN
  SELECT RAISE(ABORT, 'governing_facts are append-only: the row exists');
END;
CREATE TRIGGER governing_facts_retired_at_write_once BEFORE UPDATE OF retired_at ON governing_facts WHEN OLD.retired_at IS NOT NULL BEGIN
  SELECT RAISE(ABORT, 'governing_facts.retired_at is write-once');
END;
CREATE TRIGGER governing_facts_reject_rewrite BEFORE UPDATE OF
  id, kind, target, text, scope_level, project, paths_json, valid_from, valid_until, supersedes_json,
  enforcement_behavior, enforcement_rule, source_kind, source_at, source_session_id, source_run_id, source_seq, source_call_id
ON governing_facts BEGIN
  SELECT RAISE(ABORT, 'governing_facts are append-only: only retired_at may be set');
END;
CREATE TRIGGER governing_facts_reject_delete BEFORE DELETE ON governing_facts BEGIN
  SELECT RAISE(ABORT, 'governing_facts are append-only: DELETE is not allowed');
END;

ALTER TABLE runs ADD COLUMN origin TEXT NOT NULL DEFAULT 'untrusted' CHECK (origin IN ('trusted', 'untrusted'));

CREATE TABLE search_docs (
  id INTEGER PRIMARY KEY,
  level TEXT NOT NULL CHECK (level IN ('run', 'step')),
  session_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  step INTEGER,
  project TEXT NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('trusted', 'untrusted')),
  outcome TEXT NOT NULL,
  seq_from INTEGER NOT NULL,
  seq_to INTEGER NOT NULL,
  at INTEGER NOT NULL,
  body TEXT NOT NULL,
  paths_json TEXT NOT NULL,
  CHECK ((level = 'step') = (step IS NOT NULL))
);
CREATE INDEX search_docs_by_run ON search_docs (run_id, level, seq_from);
CREATE INDEX search_docs_by_project ON search_docs (project, at DESC);
CREATE TRIGGER search_docs_reject_replace BEFORE INSERT ON search_docs WHEN EXISTS (SELECT 1 FROM search_docs WHERE id = NEW.id) BEGIN
  SELECT RAISE(ABORT, 'search_docs are not replaced: the row exists');
END;
CREATE VIRTUAL TABLE search_index USING fts5(body, content = 'search_docs', content_rowid = 'id', tokenize = 'trigram');
CREATE TRIGGER search_docs_index_insert AFTER INSERT ON search_docs BEGIN
  INSERT INTO search_index (rowid, body) VALUES (NEW.id, NEW.body);
END;
CREATE TRIGGER search_docs_index_delete AFTER DELETE ON search_docs BEGIN
  INSERT INTO search_index (search_index, rowid, body) VALUES ('delete', OLD.id, OLD.body);
END;
CREATE TRIGGER search_docs_index_update AFTER UPDATE ON search_docs BEGIN
  INSERT INTO search_index (search_index, rowid, body) VALUES ('delete', OLD.id, OLD.body);
  INSERT INTO search_index (rowid, body) VALUES (NEW.id, NEW.body);
END;
CREATE TRIGGER search_docs_session_delete AFTER DELETE ON sessions BEGIN
  DELETE FROM search_docs WHERE session_id = OLD.id;
END;

CREATE INDEX events_by_status_change ON events (id) WHERE type = 'run.status';

CREATE TABLE blob_owners (
  sha256 TEXT NOT NULL REFERENCES blobs (sha256),
  run_id TEXT NOT NULL REFERENCES runs (id),
  PRIMARY KEY (sha256, run_id)
);
CREATE INDEX blob_owners_by_run ON blob_owners (run_id);
INSERT OR IGNORE INTO blob_owners (sha256, run_id)
  SELECT json_extract(payload_json, '$.handle'), run_id FROM events
  WHERE run_id IS NOT NULL AND json_extract(payload_json, '$.handle') IN (SELECT sha256 FROM blobs);
INSERT OR IGNORE INTO blob_owners (sha256, run_id)
  SELECT output_handle, run_id FROM jobs WHERE output_handle IS NOT NULL AND output_handle IN (SELECT sha256 FROM blobs);

CREATE TABLE search_cursor (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_event_id INTEGER NOT NULL
);
INSERT INTO search_cursor (id, last_event_id) VALUES (1, 0);

CREATE TABLE reflection_jobs (
  run_id TEXT PRIMARY KEY REFERENCES runs (id),
  state TEXT NOT NULL CHECK (state IN ('pending', 'running', 'done', 'failed')),
  attempts INTEGER NOT NULL,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX reflection_jobs_by_state ON reflection_jobs (state, created_at);

CREATE TABLE context_charges (
  id INTEGER PRIMARY KEY,
  purpose TEXT NOT NULL CHECK (purpose IN ('reflection', 'guideline')),
  run_id TEXT REFERENCES runs (id),
  project TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL CHECK (input_tokens >= 0),
  output_tokens INTEGER NOT NULL CHECK (output_tokens >= 0),
  total_tokens INTEGER NOT NULL CHECK (total_tokens >= 0),
  created_at INTEGER NOT NULL
);
CREATE INDEX context_charges_by_run ON context_charges (run_id) WHERE run_id IS NOT NULL;

CREATE TABLE compaction_guidelines (
  version INTEGER PRIMARY KEY,
  text TEXT NOT NULL,
  parent INTEGER REFERENCES compaction_guidelines (version),
  created_at INTEGER NOT NULL,
  adopted_at INTEGER,
  report_json TEXT NOT NULL
);
`;

const EVENT_PINNED_DIGEST = `
ALTER TABLE events ADD COLUMN pinned_digest TEXT;
CREATE INDEX events_model_requests ON events (run_id, seq, pinned_digest) WHERE type = 'model.requested';
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
  { version: 6, name: 'store long-term memories with their scope, source and use times', sql: LONG_TERM_MEMORIES },
  { version: 7, name: 'let an approval carry an MCP elicitation and its answers', sql: ELICITATION_APPROVALS },
  { version: 8, name: 'link subagent runs to the run and tool call that spawned them, and record background jobs', sql: SUBAGENT_RUNS_AND_BACKGROUND_JOBS },
  { version: 9, name: 'let a session carry the MCP servers its client passed', sql: SESSION_MCP_SERVERS },
  { version: 10, name: 'record whether a memory was saved in a trusted folder', sql: MEMORY_TRUST_ORIGIN },
  { version: 11, name: 'remember which call last read a job and where its read began, so a replayed read returns the same bytes', sql: JOB_READ_REPLAY },
  { version: 12, name: 'record the lease token under which an idempotency record was begun or adopted', sql: IDEMPOTENCY_LEASE_TOKEN },
  {
    version: 13,
    name: 'add governing facts, memory evidence and lifecycle, the hierarchical search index, reflection jobs and compaction guidelines',
    sql: EVIDENCE_BASED_CONTEXT,
  },
  { version: 14, name: 'copy the pinned-layer digest of a recorded model request into a column, so a terminal can find the distinct layers without reading the bodies', sql: EVENT_PINNED_DIGEST },
  { version: 15, name: 'record the candidates a reflection dropped and why', sql: REFLECTION_DROPPED_CANDIDATES },
  { version: 16, name: 'record the cache, cost and timing of a context charge', sql: CONTEXT_CHARGE_DETAIL },
];
