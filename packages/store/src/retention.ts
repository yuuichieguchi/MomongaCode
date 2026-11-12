import type { DatabaseSync } from 'node:sqlite';
import { immediateTx } from '@momonga/foundation';
import type { Clock } from '@momonga/foundation';
import type { BlobCollector } from './blobs.ts';
import { readerFor } from './rows.ts';

export const RETENTION_SESSIONS_PER_PAGE = 32;

export const RETENTION_CLOSURES_PER_SWEEP = 64;

export const RETENTION_BLOBS_PER_SWEEP = 256;

export type RetentionRule = 'delete' | 'edge' | 'kept' | 'sweep';

export type RetentionTable = { table: string; column: string; refers: 'session' | 'run'; rule: RetentionRule };

const deleted = (table: string, column: string, refers: 'session' | 'run'): RetentionTable => ({ table, column, refers, rule: 'delete' });

export const RETENTION_TABLES: readonly RetentionTable[] = [
  deleted('approvals', 'run_id', 'run'),
  deleted('blob_owners', 'run_id', 'run'),
  deleted('context_charges', 'run_id', 'run'),
  deleted('derived_through', 'run_id', 'run'),
  deleted('fidelity_verdicts', 'run_id', 'run'),
  deleted('meter_records', 'run_id', 'run'),
  deleted('meter_records', 'session_id', 'session'),
  deleted('permission_reviews', 'run_id', 'run'),
  deleted('reflection_jobs', 'run_id', 'run'),
  deleted('run_answerers', 'run_id', 'run'),
  deleted('run_calls', 'run_id', 'run'),
  deleted('run_facts', 'run_id', 'run'),
  deleted('run_facts', 'root_run_id', 'run'),
  deleted('run_facts', 'session_id', 'session'),
  deleted('run_indexed_chars', 'run_id', 'run'),
  deleted('run_records', 'run_id', 'run'),
  deleted('run_recoveries', 'run_id', 'run'),
  deleted('search_docs', 'run_id', 'run'),
  deleted('search_docs', 'session_id', 'session'),
  deleted('search_draft_parts', 'run_id', 'run'),
  deleted('search_draft_paths', 'run_id', 'run'),
  deleted('search_draft_steps', 'run_id', 'run'),
  deleted('search_draft_runs', 'run_id', 'run'),
  deleted('snapshots', 'run_id', 'run'),
  deleted('started_calls', 'run_id', 'run'),
  deleted('jobs', 'run_id', 'run'),
  deleted('jobs', 'session_id', 'session'),
  deleted('events', 'run_id', 'run'),
  deleted('events', 'session_id', 'session'),
  deleted('run_inbox', 'session_id', 'session'),
  deleted('session_touched', 'session_id', 'session'),
  { table: 'runs', column: 'previous_run_id', refers: 'run', rule: 'edge' },
  { table: 'runs', column: 'parent_run_id', refers: 'run', rule: 'edge' },
  deleted('runs', 'id', 'run'),
  deleted('runs', 'session_id', 'session'),
  deleted('sessions', 'id', 'session'),
  { table: 'memories', column: 'source_run_id', refers: 'run', rule: 'kept' },
  { table: 'memories', column: 'source_session_id', refers: 'session', rule: 'kept' },
  { table: 'memory_evidence', column: 'run_id', refers: 'run', rule: 'kept' },
  { table: 'governing_facts', column: 'source_run_id', refers: 'run', rule: 'kept' },
  { table: 'governing_facts', column: 'source_session_id', refers: 'session', rule: 'kept' },
  { table: 'issue_watch_starts', column: 'started_run_id', refers: 'run', rule: 'kept' },
  { table: 'retention_sweeps', column: 'session_id', refers: 'session', rule: 'sweep' },
];

export type RetentionPurge = (runIds: readonly string[], cutoffMs: number, signal: AbortSignal) => Promise<void>;

export type RetentionSweepRequest = { periodMs: number; purges: readonly RetentionPurge[] };

export type RetentionSweepReport = { sessionsDeleted: number; runsPurged: number; blobsCollected: number; more: boolean };

export type RetentionStore = { sweep(request: RetentionSweepRequest, signal: AbortSignal): Promise<RetentionSweepReport> };

const TERMINAL = "('COMPLETED', 'STOPPED', 'FAILED', 'CANCELLED')";

const quoted = (name: string): string => `"${name}"`;

const marks = (count: number): string => Array.from({ length: count }, () => '?').join(', ');

type Closure = { sessionIds: string[]; runIds: string[] };

const prepareStatements = (db: DatabaseSync) => ({
  candidates: db.prepare(
    `SELECT s.id, s.created_at FROM sessions s
     WHERE (s.created_at, s.id) > (:afterCreatedAt, :afterId)
     ORDER BY s.created_at, s.id LIMIT :limit`,
  ),
  expired: db.prepare(
    `SELECT 1 AS expired FROM sessions s
     WHERE s.id = :id AND s.created_at <= :cutoff
       AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.session_id = s.id AND (r.created_at > :cutoff OR r.status NOT IN ${TERMINAL}))
       AND COALESCE((SELECT e.created_at FROM events e WHERE e.session_id = s.id ORDER BY e.id DESC LIMIT 1), 0) <= :cutoff
       AND NOT EXISTS (SELECT 1 FROM run_inbox i WHERE i.session_id = s.id AND (i.state = 'pending' OR i.created_at > :cutoff OR i.settled_at > :cutoff))
       AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.session_id = s.id AND j.status = 'running')`,
  ),
  neighbours: db.prepare(
    `SELECT DISTINCT other.session_id AS session_id FROM runs mine JOIN runs other ON other.id = mine.parent_run_id OR other.parent_run_id = mine.id
     WHERE mine.session_id = :id AND other.session_id <> :id`,
  ),
  runsOf: db.prepare('SELECT id FROM runs WHERE session_id = :id ORDER BY ordinal'),
  record: db.prepare('INSERT INTO retention_sweeps (session_id, run_ids_json, cutoff_ms, started_at) VALUES (:sessionId, :runIds, :cutoffMs, :startedAt)'),
  pending: db.prepare('SELECT session_id, run_ids_json FROM retention_sweeps ORDER BY started_at, session_id'),
  finish: db.prepare('DELETE FROM retention_sweeps WHERE session_id = :sessionId'),
});

const DELETE_ORDER = RETENTION_TABLES.filter((entry) => entry.rule === 'delete');

export type RetentionSweepPorts = { db: DatabaseSync; clock: Clock; blobs: BlobCollector };

const closureOf = (statements: ReturnType<typeof prepareStatements>, start: string): string[] => {
  const seen = new Set<string>([start]);
  const queue = [start];
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    for (const row of statements.neighbours.all({ id: next })) {
      const neighbour = readerFor('runs', next, row).string('session_id');
      if (seen.has(neighbour)) continue;
      seen.add(neighbour);
      queue.push(neighbour);
    }
  }
  return [...seen];
};

const deleteClosure = (db: DatabaseSync, closure: Closure): void => {
  for (const entry of DELETE_ORDER) {
    const ids = entry.refers === 'session' ? closure.sessionIds : closure.runIds;
    if (ids.length === 0) continue;
    db.prepare(`DELETE FROM ${quoted(entry.table)} WHERE ${quoted(entry.column)} IN (${marks(ids.length)})`).run(...ids);
  }
};

const removeExpiredClosures = (ports: RetentionSweepPorts, statements: ReturnType<typeof prepareStatements>, cutoffMs: number): { sessions: number; more: boolean } => {
  let sessions = 0;
  let closures = 0;
  let after = { createdAt: Number.MIN_SAFE_INTEGER, id: '' };
  for (;;) {
    const page = statements.candidates.all({ afterCreatedAt: after.createdAt, afterId: after.id, limit: RETENTION_SESSIONS_PER_PAGE });
    if (page.length === 0) return { sessions, more: false };
    const handled = new Set<string>();
    for (const row of page) {
      const reader = readerFor('sessions', 'retention', row);
      const id = reader.string('id');
      after = { createdAt: reader.number('created_at'), id };
      if (handled.has(id)) continue;
      const removed = immediateTx(ports.db, () => {
        if (statements.expired.get({ id, cutoff: cutoffMs }) === undefined) return 0;
        const sessionIds = closureOf(statements, id);
        for (const member of sessionIds) handled.add(member);
        if (sessionIds.some((member) => statements.expired.get({ id: member, cutoff: cutoffMs }) === undefined)) return 0;
        const runIdsBySession = sessionIds.map((member) => statements.runsOf.all({ id: member }).map((run) => readerFor('runs', member, run).string('id')));
        const startedAt = ports.clock.now();
        sessionIds.forEach((sessionId, index) => {
          statements.record.run({ sessionId, runIds: JSON.stringify(runIdsBySession[index]), cutoffMs, startedAt });
        });
        deleteClosure(ports.db, { sessionIds, runIds: runIdsBySession.flat() });
        return sessionIds.length;
      });
      if (removed === 0) continue;
      sessions += removed;
      closures += 1;
      if (closures >= RETENTION_CLOSURES_PER_SWEEP) return { sessions, more: true };
    }
  }
};

const pendingSweeps = (statements: ReturnType<typeof prepareStatements>): { sessionIds: string[]; runIds: string[] } => {
  const sessionIds: string[] = [];
  const runIds: string[] = [];
  for (const row of statements.pending.all()) {
    const reader = readerFor('retention_sweeps', 'pending', row);
    sessionIds.push(reader.string('session_id'));
    const recorded: unknown = reader.json('run_ids_json');
    if (!Array.isArray(recorded) || !recorded.every((runId): runId is string => typeof runId === 'string')) {
      throw new Error(`retention_sweeps row of session ${reader.string('session_id')} holds run ids that are not a list of text`);
    }
    runIds.push(...recorded);
  }
  return { sessionIds, runIds };
};

export const retentionSweep = async (ports: RetentionSweepPorts, request: RetentionSweepRequest, signal: AbortSignal): Promise<RetentionSweepReport> => {
  signal.throwIfAborted();
  const statements = prepareStatements(ports.db);
  const cutoffMs = ports.clock.now() - request.periodMs;
  const removed = removeExpiredClosures(ports, statements, cutoffMs);
  const pending = pendingSweeps(statements);
  for (const purge of request.purges) {
    signal.throwIfAborted();
    await purge(pending.runIds, cutoffMs, signal);
  }
  immediateTx(ports.db, () => {
    for (const sessionId of pending.sessionIds) statements.finish.run({ sessionId });
  });
  const blobsCollected = ports.blobs.collectUnowned(RETENTION_BLOBS_PER_SWEEP);
  return { sessionsDeleted: removed.sessions, runsPurged: pending.runIds.length, blobsCollected, more: removed.more || blobsCollected >= RETENTION_BLOBS_PER_SWEEP };
};
