import fs from 'node:fs';
import { rotatedLogPath } from '@momonga/foundation';
import type { MomongaPaths } from '@momonga/foundation';
import { processRunning } from './process.ts';
import { until } from './wait.ts';

export type LogRecord = { readonly ts: string; readonly level: string; readonly service: string; readonly pid: number; readonly msg: string } & Readonly<Record<string, unknown>>;

const isLogRecord = (value: unknown): value is LogRecord =>
  typeof value === 'object' &&
  value !== null &&
  'ts' in value &&
  typeof value.ts === 'string' &&
  'level' in value &&
  typeof value.level === 'string' &&
  'service' in value &&
  typeof value.service === 'string' &&
  'pid' in value &&
  typeof value.pid === 'number' &&
  'msg' in value &&
  typeof value.msg === 'string';

const parseLine = (file: string, line: string): LogRecord => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (error) {
    throw new Error(`${file} has a complete line that is not JSON: ${line}`, { cause: error });
  }
  if (!isLogRecord(parsed)) throw new Error(`${file} has a JSON line that is not a log record: ${line}`);
  return parsed;
};

export const readLog = (file: string): LogRecord[] => {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const lines = text.split('\n');
  lines.pop();
  return lines.filter((line) => line !== '').map((line) => parseLine(file, line));
};

export const supervisorPidsOf = (paths: MomongaPaths): number[] => [
  ...new Set([...readLog(rotatedLogPath(paths.logFiles.supervisor, 1)), ...readLog(paths.logFiles.supervisor)].map((record) => Number(record.pid))),
];

const recordsOf = (paths: MomongaPaths, supervisorPid: number): LogRecord[] =>
  [...readLog(rotatedLogPath(paths.logFiles.supervisor, 1)), ...readLog(paths.logFiles.supervisor)].filter((record) => record.pid === supervisorPid);

export const supervisorLog = (paths: MomongaPaths, supervisorPid: number, running: (pid: number) => boolean = processRunning): LogRecord[] => {
  if (running(supervisorPid)) throw new Error(`supervisor ${supervisorPid} still runs, so its log may not hold a record of what was seen yet; wait for the record with untilRecord`);
  return recordsOf(paths, supervisorPid);
};

export type RecordMatch = (record: LogRecord) => boolean;

export const recordNamed =
  (msg: string, fields: Readonly<Record<string, unknown>> = {}): RecordMatch =>
  (record) =>
    record.msg === msg && Object.entries(fields).every(([key, value]) => record[key] === value);

export const untilRecord = (
  paths: MomongaPaths,
  supervisorPid: number,
  awaited: RecordMatch | readonly RecordMatch[],
  options: { deadlineMs: number; description: string },
): Promise<LogRecord[]> => {
  const matches = typeof awaited === 'function' ? [awaited] : awaited;
  return until(
    () => {
      const records = recordsOf(paths, supervisorPid);
      return matches.every((match) => records.some(match)) ? records : undefined;
    },
    { deadlineMs: options.deadlineMs, description: `supervisor ${supervisorPid} to log ${options.description}` },
  );
};
