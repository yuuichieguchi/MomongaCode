import type { DatabaseSync } from 'node:sqlite';
import { canonicalJson, immediateTx } from '@momonga/foundation';
import type { Clock } from '@momonga/foundation';
import { MEMORY_ORIGINS, REFLECTION_DROP_CAUSES, REFLECTION_JOB_STATES } from '@momonga/protocol';
import type { ReflectionDrop, RunEventPayload } from '@momonga/protocol';
import { corrupt, expectOneOf, expectRecord, readerFor, storedOneOf } from './rows.ts';
import type { DecodeContext } from './decode-context.ts';
import type { Row } from './rows.ts';
import type { MemoryStore, ReflectionJob, ReflectionStore } from './types.ts';

const decodeDropped = (identity: string, value: unknown): ReflectionDrop[] => {
  if (value === null) return [];
  if (!Array.isArray(value)) throw corrupt('reflection_jobs', identity, 'column dropped_json must be a JSON array');
  return value.map((entry: unknown): ReflectionDrop => {
    const record = expectRecord('reflection_jobs', identity, 'dropped_json', entry);
    const { ordinal, text, cause, reason } = record;
    if (typeof ordinal !== 'number' || (text !== null && typeof text !== 'string') || typeof cause !== 'string' || typeof reason !== 'string') {
      throw corrupt('reflection_jobs', identity, 'column dropped_json holds an entry of the wrong shape');
    }
    return { ordinal, text, cause: expectOneOf('reflection_jobs', identity, 'dropped_json', REFLECTION_DROP_CAUSES, cause), reason };
  });
};

const decodeJob = (row: Row, context: DecodeContext): ReflectionJob => {
  const identity = String(row['run_id']);
  const reader = readerFor('reflection_jobs', identity, row);
  return {
    runId: reader.string('run_id'),
    state: storedOneOf(context, 'reflection_jobs', identity, 'state', REFLECTION_JOB_STATES, reader.string('state')),
    attempts: reader.number('attempts'),
    lastError: reader.nullableString('last_error'),
    dropped: decodeDropped(identity, reader.nullableJson('dropped_json')),
    createdAt: reader.number('created_at'),
    updatedAt: reader.number('updated_at'),
  };
};

export const createReflectionStore = (
  db: DatabaseSync,
  clock: Clock,
  writers: { memories: Pick<MemoryStore, 'saveCandidate'>; endedRun: { append(runId: string, payloads: readonly RunEventPayload[]): void } },
  context: DecodeContext,
): ReflectionStore => {
  const insert = db.prepare("INSERT OR IGNORE INTO reflection_jobs (run_id, state, attempts, created_at, updated_at) VALUES (:runId, 'pending', 0, :now, :now)");
  const select = db.prepare('SELECT * FROM reflection_jobs WHERE run_id = :runId');
  const oldestOpen = db.prepare("SELECT * FROM reflection_jobs WHERE state IN ('pending', 'running') ORDER BY created_at, rowid");
  const ahead = db.prepare(
    `SELECT COUNT(*) AS n FROM reflection_jobs o JOIN reflection_jobs t ON t.run_id = :runId
     WHERE o.state IN ('pending', 'running') AND o.run_id != t.run_id
       AND (o.created_at < t.created_at OR (o.created_at = t.created_at AND o.rowid < t.rowid))`,
  );
  const begin = db.prepare("UPDATE reflection_jobs SET state = 'running', attempts = attempts + 1, updated_at = :now WHERE run_id = :runId AND state IN ('pending', 'running')");
  const latestForProject = db.prepare(
    `SELECT j.* FROM reflection_jobs j
     JOIN runs r ON r.id = j.run_id
     JOIN sessions s ON s.id = r.session_id
     WHERE s.cwd = :project
     ORDER BY j.updated_at DESC, j.rowid DESC
     LIMIT 1`,
  );
  const finish = db.prepare(
    "UPDATE reflection_jobs SET state = 'done', last_error = :reason, dropped_json = :dropped, updated_at = :now WHERE run_id = :runId AND state = 'running'",
  );
  const fail = db.prepare("UPDATE reflection_jobs SET state = 'failed', last_error = :reason, updated_at = :now WHERE run_id = :runId AND state = 'running'");
  const release = db.prepare("UPDATE reflection_jobs SET attempts = attempts - 1, updated_at = :now WHERE run_id = :runId AND state = 'running' AND attempts > 0");
  const origin = db.prepare('SELECT origin FROM runs WHERE id = :runId');

  const required = (runId: string): ReflectionJob => {
    const row = select.get({ runId });
    if (row === undefined) throw new Error(`reflection job ${runId} does not exist`);
    return decodeJob(row, context);
  };

  const finishJob = (runId: string, reason: string | undefined, dropped: readonly ReflectionDrop[] = []): ReflectionJob => {
    const recorded = dropped.length === 0 ? null : canonicalJson(dropped);
    if (Number(finish.run({ runId, reason: reason ?? null, dropped: recorded, now: clock.now() }).changes) !== 1) {
      throw new Error(`reflection job ${runId} cannot finish: it is not running`);
    }
    return required(runId);
  };

  return {
    runOrigin: (runId) => {
      const row = origin.get({ runId });
      return row === undefined ? undefined : storedOneOf(context, 'runs', runId, 'origin', MEMORY_ORIGINS, readerFor('runs', runId, row).string('origin'));
    },
    enqueue: (runId) => Number(insert.run({ runId, now: clock.now() }).changes) === 1,
    get: (runId) => {
      const row = select.get({ runId });
      return row === undefined ? undefined : decodeJob(row, context);
    },
    latestForProject: (project) => {
      const row = latestForProject.get({ project });
      return row === undefined ? undefined : decodeJob(row, context);
    },
    aheadOf: (runId) => {
      const row = ahead.get({ runId });
      if (row === undefined) throw new Error(`could not count the reflection jobs ahead of ${runId}`);
      return readerFor('reflection_jobs', runId, row).number('n');
    },
    next: (exclude = new Set()) => oldestOpen.all().map((row) => decodeJob(row, context)).find((job) => !exclude.has(job.runId)),
    begin: (runId) => {
      if (Number(begin.run({ runId, now: clock.now() }).changes) !== 1) throw new Error(`reflection job ${runId} cannot begin: it is missing or finished`);
      return required(runId);
    },
    release: (runId) => {
      if (Number(release.run({ runId, now: clock.now() }).changes) !== 1) throw new Error(`reflection job ${runId} cannot release an attempt: it is not running or has taken none`);
      return required(runId);
    },
    finish: (runId, reason) => finishJob(runId, reason),
    complete: ({ runId, charge, notice, candidates, dropped, reason }) =>
      immediateTx(db, () => {
        writers.endedRun.append(runId, [...(charge === null ? [] : [charge.charged]), ...(notice === undefined ? [] : [notice])]);
        for (const candidate of candidates) writers.memories.saveCandidate(candidate);
        return finishJob(runId, reason, dropped);
      }),
    fail: (runId, reason, charge, candidates = []) =>
      immediateTx(db, () => {
        if (charge !== undefined) writers.endedRun.append(charge.runId, [charge.charged]);
        for (const candidate of candidates) writers.memories.saveCandidate(candidate);
        if (Number(fail.run({ runId, reason, now: clock.now() }).changes) !== 1) throw new Error(`reflection job ${runId} cannot fail: it is not running`);
        return required(runId);
      }),
  };
};
