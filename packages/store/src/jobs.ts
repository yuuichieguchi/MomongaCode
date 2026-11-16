import type { DatabaseSync } from 'node:sqlite';
import { JOB_STATUSES } from '@momonga/protocol';
import { readerFor, storedOneOf } from './rows.ts';
import type { DecodeContext } from './decode-context.ts';
import type { Row } from './rows.ts';
import type { Job } from './types.ts';

export const decodeJob = (row: Row, context: DecodeContext): Job => {
  const identity = String(row['id']);
  const reader = readerFor('jobs', identity, row);
  const pgid = reader.nullableNumber('pgid');
  const exitCode = reader.nullableNumber('exit_code');
  const signal = reader.nullableString('signal');
  const outputHandle = reader.nullableString('output_handle');
  const endedAt = reader.nullableNumber('ended_at');
  const readCall = reader.nullableString('read_call');
  const readBefore = reader.nullableNumber('read_before');
  const ownerGeneration = reader.nullableNumber('owner_generation');
  const killRequestedAt = reader.nullableNumber('kill_requested_at');
  const outputPath = reader.nullableString('output_path');
  const outputIncomplete = reader.number('output_incomplete');
  return {
    id: reader.string('id'),
    idemKey: reader.string('idem_key'),
    sessionId: reader.string('session_id'),
    runId: reader.string('run_id'),
    callId: reader.string('call_id'),
    command: reader.string('command'),
    status: storedOneOf(context, 'jobs', identity, 'status', JOB_STATUSES, reader.string('status')),
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
    ...(ownerGeneration === null ? {} : { ownerGeneration }),
    ...(killRequestedAt === null ? {} : { killRequestedAt }),
    ...(outputPath === null ? {} : { outputPath }),
    ...(outputIncomplete === 1 ? { outputIncomplete: true as const } : {}),
  };
};

export const prepareJobStatements = (db: DatabaseSync) => ({
  insert: db.prepare(
    `INSERT INTO jobs (id, idem_key, session_id, run_id, call_id, command, status, output_start, output_total, read_offset, started_at, owner_generation, output_path)
     VALUES (:id, :idemKey, :sessionId, :runId, :callId, :command, 'running', 0, 0, 0, :startedAt, :ownerGeneration, :outputPath)`,
  ),
  select: db.prepare('SELECT * FROM jobs WHERE id = :id'),
  selectByKey: db.prepare('SELECT * FROM jobs WHERE idem_key = :idemKey'),
  attach: db.prepare("UPDATE jobs SET pgid = :pgid WHERE id = :id AND status = 'running'"),
  running: db.prepare("SELECT * FROM jobs WHERE status = 'running' ORDER BY started_at, rowid"),
  forSession: db.prepare('SELECT * FROM jobs WHERE session_id = :sessionId ORDER BY started_at, rowid'),
  finish: db.prepare(
    `UPDATE jobs SET status = :status, exit_code = :exitCode, signal = :signal, output_handle = :outputHandle,
       output_start = :outputStart, output_total = :outputTotal, ended_at = :endedAt, output_incomplete = :outputIncomplete
     WHERE id = :id AND status = 'running'`,
  ),
  requestKill: db.prepare("UPDATE jobs SET kill_requested_at = :now WHERE id = :id AND status = 'running' AND kill_requested_at IS NULL"),
  clearOutputPath: db.prepare('UPDATE jobs SET output_path = NULL WHERE id = :id'),
  advance: db.prepare(
    `UPDATE jobs SET read_before = CASE WHEN read_call = :call THEN read_before ELSE read_offset END, read_call = :call, read_offset = :offset
     WHERE id = :id AND (read_call = :call OR read_offset < :offset)`,
  ),
});
