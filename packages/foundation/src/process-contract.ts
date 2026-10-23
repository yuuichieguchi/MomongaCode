import type { Clock } from './clock.ts';

export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;
export const EXIT_ALREADY_RUNNING = 75;
export const EXIT_CONFIG = 78;

export const MINIMAL_CHILD_ENV_NAMES = ['PATH', 'HOME', 'LANG', 'TMPDIR'] as const;
export const MINIMAL_CHILD_ENV_LC_PREFIX = 'LC_';

export interface TextStream {
  write(chunk: string): boolean;
}

export interface ReadyFields {
  service: string;
  pid: number;
  version: string;
  socketPath: string;
  startedAt: string;
}

export const announceReady = (fields: ReadyFields, stream: TextStream = process.stdout): void => {
  const { service, pid, version, socketPath, startedAt } = fields;
  stream.write(`${JSON.stringify({ event: 'ready', service, pid, version, socketPath, startedAt })}\n`);
};

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogFields {
  runId?: string;
  workerId?: string;
  traceId?: string;
  step?: string;
  count?: number;
  ids?: readonly string[];
  err?: Error;
}

export interface JsonLogger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
}

export interface JsonLoggerOptions {
  service: string;
  clock: Clock;
  stream?: TextStream;
  level?: LogLevel;
}

const LEVEL_RANK = { debug: 0, info: 1, warn: 2, error: 3 } as const satisfies Record<LogLevel, number>;

export const createJsonLogger = ({ service, clock, stream = process.stderr, level = 'info' }: JsonLoggerOptions): JsonLogger => {
  const emit = (entryLevel: LogLevel, msg: string, fields: LogFields = {}): void => {
    if (LEVEL_RANK[entryLevel] < LEVEL_RANK[level]) return;
    const { runId, workerId, traceId, step, count, ids, err } = fields;
    const entry = {
      ts: new Date(clock.now()).toISOString(),
      level: entryLevel,
      service,
      pid: process.pid,
      msg,
      ...(runId === undefined ? {} : { runId }),
      ...(workerId === undefined ? {} : { workerId }),
      ...(traceId === undefined ? {} : { traceId }),
      ...(step === undefined ? {} : { step }),
      ...(count === undefined ? {} : { count }),
      ...(ids === undefined ? {} : { ids }),
      ...(err === undefined ? {} : { err: { name: err.name, message: err.message, stack: err.stack } }),
    };
    stream.write(`${JSON.stringify(entry)}\n`);
  };
  return {
    debug: (msg, fields) => emit('debug', msg, fields),
    info: (msg, fields) => emit('info', msg, fields),
    warn: (msg, fields) => emit('warn', msg, fields),
    error: (msg, fields) => emit('error', msg, fields),
  };
};
