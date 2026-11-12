import fs from 'node:fs';
import { rotatedLogPath } from '@momonga/foundation';
import type { MomongaPaths } from '@momonga/foundation';

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

export const supervisorLog = (paths: MomongaPaths, supervisorPid: number): LogRecord[] =>
  [...readLog(rotatedLogPath(paths.logFiles.supervisor, 1)), ...readLog(paths.logFiles.supervisor)].filter((record) => record.pid === supervisorPid);
