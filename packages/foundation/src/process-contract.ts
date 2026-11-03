import type { Clock } from './clock.ts';

export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;
export const EXIT_ALREADY_RUNNING = 75;
export const EXIT_VERSION_MISMATCH = 76;
export const EXIT_CONFIG = 78;

export const MINIMAL_CHILD_ENV_NAMES = ['PATH', 'HOME', 'LANG', 'TMPDIR'] as const;
export const MINIMAL_CHILD_ENV_LC_PREFIX = 'LC_';

export const RUNTIME_ABORT_BUDGET_MS = 5000;
export const RUNTIME_TEARDOWN_BUDGET_MS = 10_000;
export const RUNTIME_DEFAULT_DRAIN_TIMEOUT_MS = 30_000;
export const GATEWAY_MAX_CLOSE_MS = 15_000;
export const ENTRY_HARD_EXIT_MARGIN_MS = 3000;
export const SHUTDOWN_MARGIN_MS = 5000;
export const STDIO_EXIT_FLUSH_MS = 1000;
export const CHILD_STDIO_FLUSH_MS = 1000;
export const KILL_CONFIRM_MS = 5000;
export const LOCAL_REQUEST_HEADERS_TIMEOUT_MS = 2000;
export const CONTROL_REQUEST_TIMEOUT_MS = 5000;
export const SUPERVISOR_RESPONSE_BOUND_MS = CONTROL_REQUEST_TIMEOUT_MS + LOCAL_REQUEST_HEADERS_TIMEOUT_MS;
export const SHUTDOWN_DRAIN_BOUND_MS = 2000;
export const SHUTDOWN_REAP_BOUND_MS = 4000;
export const SHUTDOWN_RELEASE_BOUND_MS = 5000;
export const MINIMAL_CHILD_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
export const LIFELINE_FD = 3;
export const DAEMON_MARKER_FD = 4;
export const LOCK_FD = 5;

export const runtimeMaxCloseMs = (drainTimeoutMs: number): number => drainTimeoutMs + RUNTIME_ABORT_BUDGET_MS + RUNTIME_TEARDOWN_BUDGET_MS;

export const runtimeStopBudgetMs = (drainTimeoutMs: number): number => runtimeMaxCloseMs(drainTimeoutMs) + SHUTDOWN_MARGIN_MS;

export const gatewayStopBudgetMs = (): number => GATEWAY_MAX_CLOSE_MS + SHUTDOWN_MARGIN_MS;

export const killedChildSettleMs = (): number => KILL_CONFIRM_MS + CHILD_STDIO_FLUSH_MS;

export const supervisorMaxCloseMs = (drainTimeoutMs: number): number =>
  SHUTDOWN_DRAIN_BOUND_MS +
  runtimeStopBudgetMs(drainTimeoutMs) +
  killedChildSettleMs() +
  gatewayStopBudgetMs() +
  killedChildSettleMs() +
  SHUTDOWN_REAP_BOUND_MS +
  SHUTDOWN_RELEASE_BOUND_MS;

export const PLATFORM_CHILD_ENV_NAMES: Readonly<Record<'linux' | 'win32', readonly string[]>> = {
  linux: ['XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS'],
  win32: ['SystemRoot', 'SystemDrive', 'windir', 'ComSpec', 'PATHEXT', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'TEMP', 'TMP'],
};

export const minimalChildPath = (source: Readonly<Record<string, string | undefined>>, platform: NodeJS.Platform): string => {
  if (platform !== 'win32') return MINIMAL_CHILD_PATH;
  const systemRoot = source['SystemRoot'];
  if (systemRoot === undefined) throw new Error('SystemRoot is required to build the minimal child PATH on win32');
  return `${systemRoot}\\System32;${systemRoot}`;
};

export const minimalChildEnv = (
  source: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform = process.platform,
): Readonly<Record<string, string>> => {
  const env: Record<string, string> = {};
  const extra = platform === 'linux' || platform === 'win32' ? PLATFORM_CHILD_ENV_NAMES[platform] : [];
  for (const name of [...MINIMAL_CHILD_ENV_NAMES, ...extra]) {
    const value = name === 'PATH' ? minimalChildPath(source, platform) : source[name];
    if (value !== undefined) env[name] = value;
  }
  for (const [name, value] of Object.entries(source)) {
    if (name.startsWith(MINIMAL_CHILD_ENV_LC_PREFIX) && value !== undefined) env[name] = value;
  }
  return env;
};

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

export const parseReadyLine = (line: string): ReadyFields | undefined => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
  const { event, service, pid, version, socketPath, startedAt } = parsed as Record<string, unknown>;
  if (event !== 'ready') return undefined;
  if (typeof service !== 'string' || typeof version !== 'string' || typeof socketPath !== 'string' || typeof startedAt !== 'string') return undefined;
  if (typeof pid !== 'number' || !Number.isInteger(pid)) return undefined;
  return { service, pid, version, socketPath, startedAt };
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
  data?: Readonly<Record<string, string | number | boolean | null>>;
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

const RESERVED_LOG_KEYS: ReadonlySet<string> = new Set(['ts', 'level', 'service', 'pid', 'msg', 'runId', 'workerId', 'traceId', 'step', 'count', 'ids', 'err']);

const extraFields = (data: NonNullable<LogFields['data']>): Record<string, string | number | boolean | null> =>
  Object.fromEntries(Object.entries(data).filter(([key]) => !RESERVED_LOG_KEYS.has(key)));

export interface LogLineInput {
  ts: string;
  level: LogLevel;
  service: string;
  msg: string;
  fields?: LogFields;
}

export const formatLogLine = ({ ts, level, service, msg, fields = {} }: LogLineInput): string => {
  const { runId, workerId, traceId, step, count, ids, err, data } = fields;
  const entry = {
    ...(data === undefined ? {} : extraFields(data)),
    ts,
    level,
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
  return `${JSON.stringify(entry)}\n`;
};

const LEVEL_RANK = { debug: 0, info: 1, warn: 2, error: 3 } as const satisfies Record<LogLevel, number>;

export const createJsonLogger = ({ service, clock, stream = process.stderr, level = 'info' }: JsonLoggerOptions): JsonLogger => {
  const emit = (entryLevel: LogLevel, msg: string, fields: LogFields = {}): void => {
    if (LEVEL_RANK[entryLevel] < LEVEL_RANK[level]) return;
    stream.write(formatLogLine({ ts: new Date(clock.now()).toISOString(), level: entryLevel, service, msg, fields }));
  };
  return {
    debug: (msg, fields) => emit('debug', msg, fields),
    info: (msg, fields) => emit('info', msg, fields),
    warn: (msg, fields) => emit('warn', msg, fields),
    error: (msg, fields) => emit('error', msg, fields),
  };
};
