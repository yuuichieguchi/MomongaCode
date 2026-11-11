import type { DatabaseSync } from 'node:sqlite';
import type { Clock } from '@momonga/foundation';
import { readerFor } from './rows.ts';
import type { Row } from './rows.ts';
import type { IssueStart, IssueWatchStore } from './types.ts';

const decodeStart = (row: Row): IssueStart => {
  const reader = readerFor('issue_watch_starts', `${String(row['project_key'])} ${String(row['reference'])}`, row);
  return { project: reader.string('project_key'), reference: reader.string('reference'), startedRunId: reader.string('started_run_id'), createdAt: reader.number('created_at') };
};

export const createIssueWatchStore = (db: DatabaseSync, clock: Clock): IssueWatchStore => {
  const insert = db.prepare('INSERT OR IGNORE INTO issue_watch_starts (project_key, reference, started_run_id, created_at) VALUES (:project, :reference, :runId, :createdAt)');
  const select = db.prepare('SELECT * FROM issue_watch_starts WHERE project_key = :project ORDER BY created_at, reference');
  return {
    recordIssueStart: (project, reference, runId) => insert.run({ project, reference, runId, createdAt: clock.now() }).changes === 1,
    issueStartsOf: (project) => select.all({ project }).map(decodeStart),
  };
};
