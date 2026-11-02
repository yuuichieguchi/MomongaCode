import type { DatabaseSync } from 'node:sqlite';
import { JOB_STATUSES } from '@momonga/protocol';
import { expectOneOf, readerFor } from './rows.ts';
import type { Row } from './rows.ts';
import type { Job } from './types.ts';

export const decodeJob = (row: Row): Job => {
  const identity = String(row['id']);
  const reader = readerFor('jobs', identity, row);
  const pgid = reader.nullableNumber('pgid');
  const exitCode = reader.nullableNumber('exit_code');
  const signal = reader.nullableString('signal');
  const outputHandle = reader.nullableString('output_handle');
  const endedAt = reader.nullableNumber('ended_at');
  const readCall = reader.nullableString('read_call');
  const readBefore = reader.nullableNumber('read_before');
  return {
    id: reader.string('id'),
    idemKey: reader.string('idem_key'),
    sessionId: reader.string('session_id'),
    runId: reader.string('run_id'),
    callId: reader.string('call_id'),
    command: reader.string('command'),
    status: expectOneOf('jobs', identity, 'status', JOB_STATUSES, reader.string('status')),
    ...(pgid === null ? {} : { pgid }),
    ...(exitCode === null ? {} : { exitCode }),
    ...(signal === null ? {} : { signal }),
    ...(outputHandle === null ? {} : { outputHandle }),
    outputStart: reader.number('output_start'),
    outputTotal: reader.number('output_total'),
    readOffset: reader.number('read_offset'),
    ...(readCall === null || readBefore === null ? {} : { lastRead: { call: readCall, from: readBefore } }),
    startedAt: reader.number('started_at'),
    ...(endedAt === null ? {} : { endedAt }),
  };
};

export const prepareJobStatements = (db: DatabaseSync) => ({
  insert: db.prepare(
    `INSERT INTO jobs (id, idem_key, session_id, run_id, call_id, command, status, output_start, output_total, read_offset, started_at)
     VALUES (:id, :idemKey, :sessionId, :runId, :callId, :command, 'running', 0, 0, 0, :startedAt)`,
  ),
  select: db.prepare('SELECT * FROM jobs WHERE id = :id'),
  selectByKey: db.prepare('SELECT * FROM jobs WHERE idem_key = :idemKey'),
  attach: db.prepare("UPDATE jobs SET pgid = :pgid WHERE id = :id AND status = 'running'"),
  running: db.prepare("SELECT * FROM jobs WHERE status = 'running' ORDER BY started_at, rowid"),
  forSession: db.prepare('SELECT * FROM jobs WHERE session_id = :sessionId ORDER BY started_at, rowid'),
  finish: db.prepare(
    `UPDATE jobs SET status = :status, exit_code = :exitCode, signal = :signal, output_handle = :outputHandle,
       output_start = :outputStart, output_total = :outputTotal, ended_at = :endedAt
     WHERE id = :id AND status = 'running'`,
  ),
  advance: db.prepare(
    `UPDATE jobs SET read_before = CASE WHEN read_call = :call THEN read_before ELSE read_offset END, read_call = :call, read_offset = :offset
     WHERE id = :id AND (read_call = :call OR read_offset < :offset)`,
  ),
});
