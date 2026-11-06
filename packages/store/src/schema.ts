import type { Migration } from '@momonga/foundation';
import { UNKNOWN_ANSWERER } from '@momonga/protocol';

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

const nearestTrustDecisionOfSession = (sessionId: string): string => `SELECT t.decision FROM sessions s JOIN trust t ON (s.cwd = t.path OR substr(s.cwd, 1, length(t.path) + 1) = t.path || '/')
     WHERE s.id = ${sessionId}
     ORDER BY length(t.path) DESC LIMIT 1`;

const MEMORY_TRUST_ORIGIN = `
ALTER TABLE memories ADD COLUMN origin TEXT NOT NULL DEFAULT 'untrusted' CHECK (origin IN ('trusted', 'untrusted'));
UPDATE memories SET origin = 'trusted'
WHERE scope = 'project'
   OR (
     ${nearestTrustDecisionOfSession('memories.source_session_id')}
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
UPDATE runs SET origin = 'trusted'
WHERE (
  ${nearestTrustDecisionOfSession('runs.session_id')}
) = 'trusted';

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

const MODEL_CHANGE_INDEX = `
CREATE INDEX events_model_changes ON events (session_id, id) WHERE type = 'model.changed';
`;

const TOOL_OFFERED_RECORD = `
CREATE INDEX events_tool_offered ON events (run_id, seq) WHERE type = 'tool.offered';
INSERT INTO events (run_id, session_id, seq, step, lease_token, created_at, type, payload_json)
SELECT r.id, r.session_id, r.last_seq + 1, r.step, r.lease_token, r.created_at, 'tool.offered',
  json_object('type', 'tool.offered', 'names', json((
    SELECT json_group_array(offered.name) FROM (
      SELECT pinned.value AS name
        FROM json_each((SELECT s.payload_json FROM events s WHERE s.run_id = r.id AND s.type = 'run.started' ORDER BY s.seq LIMIT 1), '$.pins.token.deferred') pinned
      UNION
      SELECT json_extract(sent.value, '$.name')
        FROM events q, json_each(q.payload_json, '$.body.tools') sent
        WHERE q.run_id = r.id AND q.type = 'model.requested'
      UNION
      SELECT listed.value
        FROM events q, json_each(q.payload_json, '$.body.tools') sent, json_each(sent.value, '$.parameters.properties.names.items.enum') listed
        WHERE q.run_id = r.id AND q.type = 'model.requested' AND json_extract(sent.value, '$.name') = 'LoadTools'
      ORDER BY 1
    ) offered
  )))
FROM runs r
WHERE EXISTS (SELECT 1 FROM events s WHERE s.run_id = r.id AND s.type = 'run.started')
  AND NOT EXISTS (SELECT 1 FROM events o WHERE o.run_id = r.id AND o.type = 'tool.offered');
UPDATE runs SET last_seq = last_seq + 1
WHERE EXISTS (SELECT 1 FROM events o WHERE o.run_id = runs.id AND o.type = 'tool.offered' AND o.seq = runs.last_seq + 1);
`;

const RUN_CANCEL_ORIGIN = `
ALTER TABLE runs ADD COLUMN cancel_origin TEXT CHECK (cancel_origin IS NULL OR cancel_origin IN ('QUEUED', 'WAITING_HUMAN', 'RUNNING', 'WAITING_TOOL'));
UPDATE runs SET cancel_origin = COALESCE(
  (
    SELECT json_extract(e.payload_json, '$.from') FROM events e
    WHERE e.run_id = runs.id AND e.type = 'run.status' AND json_extract(e.payload_json, '$.to') = 'CANCELLING'
      AND json_extract(e.payload_json, '$.from') IN ('RUNNING', 'WAITING_TOOL')
    ORDER BY e.seq DESC LIMIT 1
  ),
  'RUNNING'
)
WHERE status = 'CANCELLING';
CREATE TRIGGER runs_cancelling_has_cancel_origin_insert BEFORE INSERT ON runs WHEN NEW.status = 'CANCELLING' AND NEW.cancel_origin IS NULL BEGIN
  SELECT RAISE(ABORT, 'a CANCELLING run must have a cancel origin');
END;
CREATE TRIGGER runs_cancelling_has_cancel_origin_update BEFORE UPDATE OF status, cancel_origin ON runs WHEN NEW.status = 'CANCELLING' AND NEW.cancel_origin IS NULL BEGIN
  SELECT RAISE(ABORT, 'a CANCELLING run must have a cancel origin');
END;
`;

const APPEND_TIME_RECORDS = `
ALTER TABLE events ADD COLUMN call_id TEXT;
ALTER TABLE events ADD COLUMN approval_id TEXT;
ALTER TABLE events ADD COLUMN tool_name TEXT;
ALTER TABLE events ADD COLUMN notice_code TEXT;
ALTER TABLE events ADD COLUMN model_call_json TEXT;

DROP TRIGGER events_reject_update;
UPDATE events SET call_id = json_extract(payload_json, '$.callId') WHERE type IN ('tool.call', 'tool.permission.requested', 'tool.elicitation.requested');
UPDATE events SET approval_id = json_extract(payload_json, '$.approvalId') WHERE type = 'tool.permission.requested';
UPDATE events SET approval_id = json_extract(payload_json, '$.inputId') WHERE type = 'tool.elicitation.requested';
UPDATE events SET tool_name = json_extract(payload_json, '$.name') WHERE type = 'tool.call';
UPDATE events SET notice_code = json_extract(payload_json, '$.code') WHERE type = 'notice';
UPDATE events SET model_call_json = json_object(
  'attempt', json_extract(payload_json, '$.attempt'),
  'anatomy', json(json_extract(payload_json, '$.anatomy')),
  'prefix', json(json_extract(payload_json, '$.prefix'))
) WHERE type = 'model.requested';
UPDATE events SET model_call_json = json_object(
  'attempt', json_extract(payload_json, '$.attempt'),
  'responseId', json_extract(payload_json, '$.response.id'),
  'timing', json(json_extract(payload_json, '$.response.timing'))
) WHERE type = 'model.responded';
CREATE TRIGGER events_reject_update BEFORE UPDATE ON events BEGIN
  SELECT RAISE(ABORT, 'events are append-only: UPDATE is not allowed');
END;

CREATE INDEX events_call_ids ON events (run_id, call_id) WHERE call_id IS NOT NULL;
CREATE INDEX events_approval_ids ON events (run_id, approval_id) WHERE approval_id IS NOT NULL;
CREATE INDEX events_tool_names ON events (run_id, tool_name) WHERE tool_name IS NOT NULL;
CREATE INDEX events_notice_codes ON events (run_id, notice_code) WHERE notice_code IS NOT NULL;

CREATE TABLE run_records (
  run_id TEXT PRIMARY KEY REFERENCES runs (id),
  final_text TEXT,
  in_flight_step INTEGER,
  in_flight_attempt INTEGER
);
CREATE TABLE started_calls (
  run_id TEXT NOT NULL REFERENCES runs (id),
  call_id TEXT NOT NULL,
  call_seq INTEGER NOT NULL,
  name TEXT NOT NULL,
  idem_key TEXT NOT NULL,
  PRIMARY KEY (run_id, call_id)
);
CREATE TABLE meter_records (
  session_id TEXT NOT NULL REFERENCES sessions (id),
  counter TEXT NOT NULL,
  context_window INTEGER NOT NULL,
  token_error_ratio REAL,
  token_counting TEXT NOT NULL,
  run_id TEXT NOT NULL REFERENCES runs (id),
  seq INTEGER NOT NULL,
  event_json TEXT NOT NULL,
  misses_json TEXT NOT NULL
);
CREATE UNIQUE INDEX meter_records_key ON meter_records (session_id, counter, context_window, COALESCE(token_error_ratio, -1), token_counting);

INSERT INTO run_records (run_id, final_text)
WITH items AS (
  SELECT e.run_id AS run_id, e.seq AS seq, CAST(o.key AS INTEGER) AS position,
    (SELECT group_concat(json_extract(p.value, '$.text'), '') FROM json_each(o.value, '$.content') p
      WHERE json_extract(p.value, '$.type') = 'output_text' AND json_type(p.value, '$.text') = 'text') AS text
  FROM events e, json_each(e.payload_json, '$.response.output') o
  WHERE e.type = 'model.responded' AND json_extract(o.value, '$.type') = 'message' AND json_extract(o.value, '$.role') = 'assistant' AND json_type(o.value, '$.content') = 'array'
),
texted AS (
  SELECT run_id, text, ROW_NUMBER() OVER (PARTITION BY run_id ORDER BY seq DESC, position DESC) AS recency FROM items WHERE text <> ''
)
SELECT run_id, text FROM texted WHERE recency = 1;

INSERT INTO run_records (run_id, in_flight_step, in_flight_attempt)
WITH RECURSIVE
last_requested AS (
  SELECT e.run_id AS run_id, e.seq AS seq, e.step AS step, json_extract(e.payload_json, '$.attempt') AS attempt
  FROM events e
  WHERE e.type = 'model.requested' AND e.seq = (SELECT MAX(x.seq) FROM events x WHERE x.run_id = e.run_id AND x.type = 'model.requested')
),
following AS (
  SELECT l.run_id AS run_id, e.type AS type, e.step AS step, json_extract(e.payload_json, '$.attempt') AS attempt,
    ROW_NUMBER() OVER (PARTITION BY l.run_id ORDER BY e.seq) AS rn
  FROM last_requested l JOIN events e ON e.run_id = l.run_id AND e.seq > l.seq AND e.type IN ('model.responded', 'model.rejected', 'context.compaction_rejected')
),
walk(run_id, rn, step, attempt, open) AS (
  SELECT run_id, 0, step, attempt, 1 FROM last_requested
  UNION ALL
  SELECT w.run_id, f.rn, w.step,
    CASE WHEN w.open = 1 AND f.type = 'model.rejected' AND f.step = w.step AND f.attempt = w.attempt THEN w.attempt + 1 ELSE w.attempt END,
    CASE WHEN w.open = 1 AND f.step = w.step AND f.attempt = w.attempt AND f.type IN ('model.responded', 'context.compaction_rejected') THEN 0 ELSE w.open END
  FROM walk w JOIN following f ON f.run_id = w.run_id AND f.rn = w.rn + 1
)
SELECT w.run_id, w.step, w.attempt FROM walk w
WHERE w.open = 1 AND w.rn = (SELECT MAX(v.rn) FROM walk v WHERE v.run_id = w.run_id)
ON CONFLICT (run_id) DO UPDATE SET in_flight_step = excluded.in_flight_step, in_flight_attempt = excluded.in_flight_attempt;

INSERT INTO started_calls (run_id, call_id, call_seq, name, idem_key)
WITH started AS (
  SELECT run_id, json_extract(payload_json, '$.callId') AS call_id, json_extract(payload_json, '$.idemKey') AS idem_key,
    ROW_NUMBER() OVER (PARTITION BY run_id, json_extract(payload_json, '$.callId') ORDER BY seq DESC) AS recency
  FROM events WHERE type = 'tool.started'
),
finished AS (
  SELECT DISTINCT run_id, json_extract(payload_json, '$.callId') AS call_id FROM events WHERE type IN ('tool.completed', 'tool.reconciled')
)
SELECT s.run_id, s.call_id, c.seq, c.tool_name, s.idem_key
FROM started s
JOIN events c ON c.run_id = s.run_id AND c.type = 'tool.call' AND c.call_id = s.call_id
LEFT JOIN finished f ON f.run_id = s.run_id AND f.call_id = s.call_id
WHERE s.recency = 1 AND f.call_id IS NULL;

INSERT INTO meter_records (session_id, counter, context_window, token_error_ratio, token_counting, run_id, seq, event_json, misses_json)
WITH observed AS (
  SELECT e.id AS id, e.session_id AS session_id, e.run_id AS run_id, e.seq AS seq, e.payload_json AS payload_json,
    json_extract(e.payload_json, '$.counter') AS counter,
    json_extract(e.payload_json, '$.contextWindow') AS context_window,
    json_extract(e.payload_json, '$.tokenErrorRatio') AS token_error_ratio,
    json_extract(e.payload_json, '$.tokenCounting') AS token_counting,
    json_extract(e.payload_json, '$.miss') AS miss,
    json_extract(e.payload_json, '$.uncounted') AS uncounted
  FROM events e WHERE e.type = 'meter.observed'
),
ranked AS (
  SELECT *, ROW_NUMBER() OVER (PARTITION BY session_id, counter, context_window, COALESCE(token_error_ratio, -1), token_counting ORDER BY id DESC) AS recency FROM observed
)
SELECT l.session_id, l.counter, l.context_window, l.token_error_ratio, l.token_counting, l.run_id, l.seq, l.payload_json,
  (SELECT json_group_array(json_object('miss', m.miss, 'uncounted', m.uncounted)) FROM (
    SELECT r.miss AS miss, r.uncounted AS uncounted FROM ranked r
    WHERE r.session_id = l.session_id AND r.counter = l.counter AND r.context_window = l.context_window
      AND COALESCE(r.token_error_ratio, -1) = COALESCE(l.token_error_ratio, -1) AND r.token_counting = l.token_counting AND r.recency <= 20
    ORDER BY r.id
  ) m)
FROM ranked l WHERE l.recency = 1;
`;

const TYPED_READ_INDEX = `
CREATE INDEX events_by_run_type ON events (run_id, type, seq);
`;

const MEMORY_RECORD_OF_FINDINGS = `
ALTER TABLE memories RENAME COLUMN last_used_at TO kept_at;
DROP INDEX memories_by_recency;
ALTER TABLE memories ADD COLUMN observed_status TEXT CHECK (observed_status IS NULL OR observed_status IN ('verified', 'unbound', 'unverifiable', 'stale'));

CREATE TRIGGER memories_reject_delete BEFORE DELETE ON memories BEGIN
  SELECT RAISE(ABORT, 'memories are retired, not deleted');
END;

CREATE TABLE memory_observations (
  memory_id TEXT NOT NULL REFERENCES memories (id),
  ordinal INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('verified', 'unbound', 'unverifiable', 'stale')),
  observed_at INTEGER NOT NULL,
  PRIMARY KEY (memory_id, ordinal)
) WITHOUT ROWID;
CREATE TRIGGER memory_observations_reject_update BEFORE UPDATE ON memory_observations BEGIN
  SELECT RAISE(ABORT, 'memory_observations is an append-only record: UPDATE is not allowed');
END;
CREATE TRIGGER memory_observations_reject_delete BEFORE DELETE ON memory_observations BEGIN
  SELECT RAISE(ABORT, 'memory_observations is an append-only record: DELETE is not allowed');
END;
CREATE TRIGGER memory_observations_index AFTER INSERT ON memory_observations BEGIN
  UPDATE memories SET observed_status = NEW.status WHERE id = NEW.memory_id;
END;

CREATE INDEX memories_by_recall ON memories (
  (CASE WHEN scope = 'user' THEN 'user:' || origin ELSE 'project:' || project END),
  (CASE observed_status WHEN 'verified' THEN 0 WHEN 'unbound' THEN 1 WHEN 'unverifiable' THEN 2 WHEN 'stale' THEN 3 ELSE 4 END),
  (-COALESCE(contributed_at, -1)),
  (-kept_at),
  id
) WHERE state = 'active' AND retired_at IS NULL;
`;

const SESSION_TOUCHED_RECORD = `
CREATE TABLE session_touched (
  session_id TEXT NOT NULL REFERENCES sessions (id),
  path TEXT NOT NULL,
  first_event_id INTEGER NOT NULL,
  PRIMARY KEY (session_id, path)
) WITHOUT ROWID;
CREATE INDEX session_touched_by_first_event ON session_touched (session_id, first_event_id, path);

INSERT OR IGNORE INTO session_touched (session_id, path, first_event_id)
SELECT e.session_id, json_extract(l.value, '$.path'), MIN(e.id)
FROM events e, json_each(e.payload_json, '$.locations') l
WHERE e.type = 'tool.call' AND json_type(l.value, '$.path') = 'text'
GROUP BY e.session_id, json_extract(l.value, '$.path');
`;

const RUN_ANSWERERS_RECORD = `
CREATE TABLE run_answerers (
  run_id TEXT NOT NULL REFERENCES runs (id),
  target TEXT NOT NULL,
  PRIMARY KEY (run_id, target)
) WITHOUT ROWID;

INSERT OR IGNORE INTO run_answerers (run_id, target)
SELECT r.run_id, COALESCE(
  json_extract(r.payload_json, '$.target'),
  (SELECT json_extract(o.payload_json, '$.target') FROM events o
    WHERE o.run_id = r.run_id AND o.type = 'meter.observed' AND o.seq > r.seq
      AND o.seq < COALESCE((SELECT MIN(q.seq) FROM events q WHERE q.run_id = r.run_id AND q.type = 'model.requested' AND q.seq > r.seq), 9223372036854775807)
    ORDER BY o.seq LIMIT 1),
  '${UNKNOWN_ANSWERER}'
)
FROM events r WHERE r.type = 'model.responded' AND r.run_id IS NOT NULL;

INSERT OR IGNORE INTO run_answerers (run_id, target)
SELECT run_id, COALESCE(json_extract(payload_json, '$.target'), '${UNKNOWN_ANSWERER}')
FROM events WHERE type IN ('model.rejected', 'usage.charged') AND run_id IS NOT NULL;
`;

const RUN_FACTS_RECORD = `
CREATE TABLE run_facts (
  run_id TEXT PRIMARY KEY REFERENCES runs (id),
  unavailable INTEGER NOT NULL CHECK (unavailable IN (0, 1)),
  definitions_version INTEGER NOT NULL,
  root_run_id TEXT,
  session_id TEXT,
  model_alias TEXT,
  mode TEXT,
  agent TEXT,
  origin TEXT,
  status TEXT,
  stop_reason TEXT,
  created_at INTEGER,
  ended_at INTEGER,
  elapsed_ms INTEGER,
  human_wait_ms INTEGER,
  tokens_total INTEGER,
  steps INTEGER,
  max_steps INTEGER,
  max_total_tokens INTEGER,
  deadline_at INTEGER,
  asked INTEGER,
  elicited INTEGER,
  authorization_required INTEGER,
  side_effecting_calls INTEGER,
  repeated_starts INTEGER,
  reconciled_already_applied INTEGER,
  reconciled_not_applied INTEGER,
  reconciled_unknown INTEGER,
  basis_read_only INTEGER,
  basis_rule INTEGER,
  basis_mode INTEGER,
  basis_hook INTEGER,
  basis_classifier INTEGER,
  basis_person INTEGER,
  declared INTEGER,
  met INTEGER
);

CREATE TABLE run_recoveries (
  run_id TEXT NOT NULL REFERENCES runs (id),
  ordinal INTEGER NOT NULL,
  cause TEXT NOT NULL CHECK (cause IN ('worker_failure', 'process_lost')),
  failed_at INTEGER NOT NULL,
  progress_at INTEGER,
  outcome TEXT NOT NULL CHECK (outcome IN ('recovered', 'unknown_effect', 'failed', 'stopped')),
  started_seq INTEGER NOT NULL,
  progress_seq INTEGER,
  PRIMARY KEY (run_id, ordinal)
) WITHOUT ROWID;

CREATE TABLE run_calls (
  run_id TEXT NOT NULL REFERENCES runs (id),
  call_id TEXT NOT NULL,
  basis TEXT CHECK (basis IS NULL OR basis IN ('read_only', 'rule', 'mode', 'hook', 'classifier', 'person')),
  side_effect TEXT CHECK (side_effect IS NULL OR side_effect IN ('read_only', 'write', 'exec')),
  asked INTEGER NOT NULL CHECK (asked IN (0, 1)),
  PRIMARY KEY (run_id, call_id)
) WITHOUT ROWID;

CREATE TABLE facts_cursor (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  definitions_version INTEGER NOT NULL,
  after_event_id INTEGER NOT NULL
);
INSERT INTO facts_cursor (id, definitions_version, after_event_id) VALUES (1, 0, 0);

CREATE TABLE permission_reviews (
  run_id TEXT NOT NULL REFERENCES runs (id),
  call_id TEXT NOT NULL,
  label TEXT NOT NULL CHECK (label IN ('correct', 'unneeded_ask', 'missed_ask')),
  reviewed_at INTEGER NOT NULL,
  PRIMARY KEY (run_id, call_id)
) WITHOUT ROWID;
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
  { version: 17, name: 'index the model switches of a session, so a resume reads them without scanning the events of the session', sql: MODEL_CHANGE_INDEX },
  { version: 18, name: 'record, for each run written before the offered-names record, the tool names it offered, derived once from its pinned deferred set and its recorded requests', sql: TOOL_OFFERED_RECORD },
  { version: 19, name: 'record the status a cancelled run had when it became CANCELLING, so a run that never ran is finished by the sweeper and not claimed', sql: RUN_CANCEL_ORIGIN },
  {
    version: 20,
    name: 'write the facts readers need at append: call, approval and tool-name columns, the model-call detail, notice codes, the final text, the in-flight request and the started calls of a run, and the meter of a session; derived once for runs written before',
    sql: APPEND_TIME_RECORDS,
  },
  { version: 21, name: 'index the events of a run by type and seq, so every read of a run\'s events of some types seeks to the matches without stepping over the others', sql: TYPED_READ_INDEX },
  {
    version: 22,
    name: 'record each evidence check of a memory as an append-only finding indexed by its newest value, rename the last-used time to the time a person kept the note, order recall by an index, and refuse to delete a memory row',
    sql: MEMORY_RECORD_OF_FINDINGS,
  },
  {
    version: 23,
    name: 'record the locations the tool calls of a session declared, once per path and in the order first seen, derived once for sessions written before',
    sql: SESSION_TOUCHED_RECORD,
  },
  {
    version: 24,
    name: 'record the targets that answered each run in run_answerers, once per target, from the target of every paid answer; derived once for runs written before by pairing each response with its meter observation, and unknown where no pairing is exact',
    sql: RUN_ANSWERERS_RECORD,
  },
  {
    version: 25,
    name: 'record the reliability facts of each terminal run as columns, its recovery episodes, the cursor of the sweeper that computes them, and the labels of reviewed permission decisions',
    sql: RUN_FACTS_RECORD,
  },
];
