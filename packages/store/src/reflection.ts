import type { DatabaseSync } from 'node:sqlite';
import type { Clock } from '@momonga/foundation';
import { MEMORY_ORIGINS } from '@momonga/protocol';
import { expectOneOf, readerFor } from './rows.ts';
import type { Row } from './rows.ts';
import type { ReflectionJob, ReflectionStore } from './types.ts';

const JOB_STATES = ['pending', 'running', 'done', 'failed'] as const;

const decodeJob = (row: Row): ReflectionJob => {
  const identity = String(row['run_id']);
  const reader = readerFor('reflection_jobs', identity, row);
  return {
    runId: reader.string('run_id'),
    state: expectOneOf('reflection_jobs', identity, 'state', JOB_STATES, reader.string('state')),
    attempts: reader.number('attempts'),
    lastError: reader.nullableString('last_error'),
    createdAt: reader.number('created_at'),
    updatedAt: reader.number('updated_at'),
  };
};

export const createReflectionStore = (db: DatabaseSync, clock: Clock): ReflectionStore => {
  const insert = db.prepare("INSERT OR IGNORE INTO reflection_jobs (run_id, state, attempts, created_at, updated_at) VALUES (:runId, 'pending', 0, :now, :now)");
  const select = db.prepare('SELECT * FROM reflection_jobs WHERE run_id = :runId');
  const oldestOpen = db.prepare("SELECT * FROM reflection_jobs WHERE state IN ('pending', 'running') ORDER BY created_at, rowid LIMIT 1");
  const begin = db.prepare("UPDATE reflection_jobs SET state = 'running', attempts = attempts + 1, updated_at = :now WHERE run_id = :runId AND state IN ('pending', 'running')");
  const finish = db.prepare("UPDATE reflection_jobs SET state = 'done', last_error = :reason, updated_at = :now WHERE run_id = :runId AND state = 'running'");
  const origin = db.prepare('SELECT origin FROM runs WHERE id = :runId');

  const required = (runId: string): ReflectionJob => {
    const row = select.get({ runId });
    if (row === undefined) throw new Error(`reflection job ${runId} does not exist`);
    return decodeJob(row);
  };

  return {
    runOrigin: (runId) => {
      const row = origin.get({ runId });
      return row === undefined ? undefined : expectOneOf('runs', runId, 'origin', MEMORY_ORIGINS, readerFor('runs', runId, row).string('origin'));
    },
    enqueue: (runId) => Number(insert.run({ runId, now: clock.now() }).changes) === 1,
    get: (runId) => {
      const row = select.get({ runId });
      return row === undefined ? undefined : decodeJob(row);
    },
    next: () => {
      const row = oldestOpen.get();
      return row === undefined ? undefined : decodeJob(row);
    },
    begin: (runId) => {
      if (Number(begin.run({ runId, now: clock.now() }).changes) !== 1) throw new Error(`reflection job ${runId} cannot begin: it is missing or finished`);
      return required(runId);
    },
    finish: (runId, reason) => {
      if (Number(finish.run({ runId, reason: reason ?? null, now: clock.now() }).changes) !== 1) throw new Error(`reflection job ${runId} cannot finish: it is not running`);
      return required(runId);
    },
  };
};
