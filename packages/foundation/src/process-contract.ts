import type { Clock } from './clock.ts';
import { POLL_INTERVAL_MS } from './wait-until.ts';
import { parseOutsideJson } from './json-depth.ts';

export const EXIT_CODES = {
  ok: { code: 0, meaning: 'success' },
  failure: { code: 1, meaning: 'general failure, refused, not restored' },
  usage: { code: 2, meaning: 'usage error' },
  keeperCompilerMissing: { code: 3, meaning: 'the build of a native helper (the Windows keeper, the Linux socket guard) found no compiler' },
  waitingForApproval: { code: 75, meaning: 'headless run waiting for approval' },
  versionMismatchReserved: { code: 76, meaning: 'reserved: version mismatch' },
  alreadyRunning: { code: 77, meaning: 'daemon already running (lock held)' },
  config: { code: 78, meaning: 'config error or entry usage error' },
  retired: { code: 79, meaning: 'retired generation exited clean' },
  signalBase: { code: 128, meaning: 'killed by signal n: this value plus n' },
  interrupted: { code: 130, meaning: 'interrupted or cancelled' },
  signatureRejected: { code: 255, meaning: 'release signature rejected' },
} as const satisfies Record<string, { code: number; meaning: string }>;

export const EXIT_OK = EXIT_CODES.ok.code;
export const EXIT_FAILURE = EXIT_CODES.failure.code;
export const EXIT_USAGE = EXIT_CODES.usage.code;
export const WINDOWS_KEEPER_COMPILER_MISSING_EXIT = EXIT_CODES.keeperCompilerMissing.code;
export const EXIT_WAITING_FOR_APPROVAL = EXIT_CODES.waitingForApproval.code;
export const EXIT_ALREADY_RUNNING = EXIT_CODES.alreadyRunning.code;
export const EXIT_CONFIG = EXIT_CODES.config.code;
export const EXIT_RETIRED = EXIT_CODES.retired.code;
export const EXIT_SIGNAL_BASE = EXIT_CODES.signalBase.code;
export const EXIT_INTERRUPTED = EXIT_CODES.interrupted.code;
export const SIGNATURE_REJECTED_EXIT_CODE = EXIT_CODES.signatureRejected.code;

export const SWEEP_INTERVAL_MS = 1000;
export const GENERATION_POLL_INTERVAL_MS = SWEEP_INTERVAL_MS;

export const MINIMAL_CHILD_ENV_NAMES = ['PATH', 'HOME', 'LANG', 'TMPDIR'] as const;
export const MINIMAL_CHILD_ENV_LC_PREFIX = 'LC_';
export const CREDENTIAL_CAPABILITY_ENV = 'MOMONGA_CREDENTIAL_CAPABILITY';
export const CREDENTIAL_CAPABILITY_HEADER = 'momonga-credential-capability';

export const KILL_CONFIRM_MS = 5000;
export const ABORT_SETTLE_LIMIT_MS = 2000;
export const SANDBOX_KILL_GRACE_MS = 1000;
export const REAP_KILL_GRACE_MS = 2 * SANDBOX_KILL_GRACE_MS;
export const DAEMON_MARKER_KILL_GRACE_MS = REAP_KILL_GRACE_MS;
export const ABANDON_KILL_GRACE_MS = REAP_KILL_GRACE_MS;
export const groupTerminationBoundMs = (graceMs: number): number => graceMs + KILL_CONFIRM_MS + 2 * POLL_INTERVAL_MS;
export const RUNTIME_ABORT_BUDGET_MS = ABORT_SETTLE_LIMIT_MS + groupTerminationBoundMs(SANDBOX_KILL_GRACE_MS);
export const RUNTIME_TEARDOWN_BUDGET_MS = 10_000;
export const STARTUP_TIMEOUT_MS = 60_000;

export const startDeadlineSignal = (given: AbortSignal | undefined): AbortSignal => given ?? AbortSignal.timeout(STARTUP_TIMEOUT_MS);
export const MARKER_REAP_GRACE_WINDOWS = 3;
export const markerReapClockBoundMs = (killGraceMs: number): number => MARKER_REAP_GRACE_WINDOWS * (killGraceMs + POLL_INTERVAL_MS) + KILL_CONFIRM_MS;
export const managedServerStopBoundMs = (stopGraceMs: number): number => stopGraceMs + KILL_CONFIRM_MS + markerReapClockBoundMs(stopGraceMs);
export const ENTRY_HARD_EXIT_MARGIN_MS = 3000;
export const SHUTDOWN_MARGIN_MS = 5000;
export const STDIO_FLUSH_MS = 1000;
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

export const KEEPER_JOB_PREFIX = 'Local\\momonga-';
export const KEEPER_PIPE_PREFIX = '\\\\.\\pipe\\momonga-keeper-';
export const KEEPER_NAME_BYTES = 16;
export const KEEPER_NAME_FORM = new RegExp(`^[0-9a-f]{${KEEPER_NAME_BYTES * 2}}$`);

export const KEEPER_EXIT_CODES = {
  usage: 0x4d4b0001,
  'pipe-unavailable': 0x4d4b0002,
  'name-taken': 0x4d4b0003,
  'containment-unavailable': 0x4d4b0004,
  'marker-unavailable': 0x4d4b0005,
  'launch-failed': 0x4d4b0006,
  'job-absent': 0x4d4b0007,
  'owner-lost': 0x4d4b0008,
  terminated: 0x4d4b0009,
} as const;

export type KeeperExitName = keyof typeof KEEPER_EXIT_CODES;

export const keeperExitName = (code: number): KeeperExitName | undefined => (Object.keys(KEEPER_EXIT_CODES) as KeeperExitName[]).find((name) => KEEPER_EXIT_CODES[name] === code);

export type StopValues = {
  readonly closeGraceMs: number;
  readonly managedServerStopGraceMs: number;
  readonly drainTimeoutMs: number;
  readonly mcpCloseGraceMs: number;
};

export type StopValueName = keyof StopValues;

export const SHUTDOWN_SETTING_LIMITS = {
  closeGraceMs: { min: 0, max: 300_000, default: 10_000 },
  managedServerStopGraceMs: { min: 0, max: 60_000, default: 3000 },
  drainTimeoutMs: { min: 0, max: 300_000, default: 30_000 },
  mcpCloseGraceMs: { min: 0, max: 30_000, default: 1000 },
} as const satisfies Record<StopValueName, { min: number; max: number; default: number }>;

export const STOP_VALUE_NAMES = ['closeGraceMs', 'managedServerStopGraceMs', 'drainTimeoutMs', 'mcpCloseGraceMs'] as const satisfies readonly StopValueName[];

const stopValuesOf = (pick: (name: StopValueName) => number): StopValues => ({
  closeGraceMs: pick('closeGraceMs'),
  managedServerStopGraceMs: pick('managedServerStopGraceMs'),
  drainTimeoutMs: pick('drainTimeoutMs'),
  mcpCloseGraceMs: pick('mcpCloseGraceMs'),
});

export const DEFAULT_STOP_VALUES: StopValues = stopValuesOf((name) => SHUTDOWN_SETTING_LIMITS[name].default);

export const MAXIMUM_STOP_VALUES: StopValues = stopValuesOf((name) => SHUTDOWN_SETTING_LIMITS[name].max);

export const RUNTIME_DEFAULT_DRAIN_TIMEOUT_MS = DEFAULT_STOP_VALUES.drainTimeoutMs;

export const MCP_CONNECT_TIMEOUT_LIMITS = { min: 1, max: 3_600_000, default: 30_000 } as const;

export const mcpConnectTimeoutProblem = (value: unknown): string | undefined => {
  const { min, max } = MCP_CONNECT_TIMEOUT_LIMITS;
  if (typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max) return undefined;
  return `must be an integer from ${min} to ${max} milliseconds; got ${JSON.stringify(value)}`;
};

export const stopValueProblem = (name: StopValueName, value: unknown): string | undefined => {
  const { min, max } = SHUTDOWN_SETTING_LIMITS[name];
  if (typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max) return undefined;
  return `must be an integer from ${min} to ${max} milliseconds; got ${JSON.stringify(value)}`;
};

export type StopValuesParse = { kind: 'values'; values: StopValues } | { kind: 'invalid'; reason: string };

export const parseStopValues = (input: unknown): StopValuesParse => {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return { kind: 'invalid', reason: 'the stop values are not an object' };
  const record = input as Readonly<Record<string, unknown>>;
  const checked: Partial<Record<StopValueName, number>> = {};
  for (const name of STOP_VALUE_NAMES) {
    const value = record[name];
    const problem = stopValueProblem(name, value);
    if (problem !== undefined) return { kind: 'invalid', reason: `${name} ${problem}` };
    checked[name] = value as number;
  }
  return { kind: 'values', values: stopValuesOf((name) => checked[name] as number) };
};

export const mcpPoolCloseBoundMs = (mcpCloseGraceMs: number): number =>
  mcpCloseGraceMs + groupTerminationBoundMs(mcpCloseGraceMs) + mcpCloseGraceMs + markerReapClockBoundMs(mcpCloseGraceMs);

export const mcpPoolsStepBoundMs = (mcpCloseGraceMs: number): number => mcpPoolCloseBoundMs(mcpCloseGraceMs);

export const runtimeTeardownBudgetMs = (mcpCloseGraceMs: number): number => RUNTIME_TEARDOWN_BUDGET_MS + mcpPoolsStepBoundMs(mcpCloseGraceMs);

export const runtimeMaxCloseMs = (values: StopValues): number => values.drainTimeoutMs + RUNTIME_ABORT_BUDGET_MS + runtimeTeardownBudgetMs(values.mcpCloseGraceMs);

export const runtimeStopBudgetMs = (values: StopValues): number => runtimeMaxCloseMs(values) + SHUTDOWN_MARGIN_MS;

export const runtimeAbortStopBudgetMs = (values: StopValues): number => RUNTIME_ABORT_BUDGET_MS + runtimeTeardownBudgetMs(values.mcpCloseGraceMs) + SHUTDOWN_MARGIN_MS;

export const gatewayMaxCloseMs = (values: StopValues): number => values.closeGraceMs + managedServerStopBoundMs(values.managedServerStopGraceMs);

export const gatewayStopBudgetMs = (values: StopValues): number => gatewayMaxCloseMs(values) + SHUTDOWN_MARGIN_MS;

export const gatewayAbortCloseMs = (values: StopValues): number => managedServerStopBoundMs(values.managedServerStopGraceMs);

export const gatewayAbortBudgetMs = (values: StopValues): number => gatewayAbortCloseMs(values) + SHUTDOWN_MARGIN_MS;

export const managedServerReapBoundMs = (values: StopValues): number => markerReapClockBoundMs(values.managedServerStopGraceMs);

export const killedChildSettleMs = (): number => KILL_CONFIRM_MS + STDIO_FLUSH_MS;

export const supervisorMaxCloseMs = (values: StopValues): number =>
  SHUTDOWN_DRAIN_BOUND_MS +
  runtimeStopBudgetMs(values) +
  killedChildSettleMs() +
  gatewayStopBudgetMs(values) +
  killedChildSettleMs() +
  managedServerReapBoundMs(values) +
  SHUTDOWN_REAP_BOUND_MS +
  SHUTDOWN_RELEASE_BOUND_MS;

export const daemonStopBoundMs = (values: StopValues): number => supervisorMaxCloseMs(values) + ENTRY_HARD_EXIT_MARGIN_MS;

export const STOP_WAIT_WHEN_UNKNOWN_MS = daemonStopBoundMs(MAXIMUM_STOP_VALUES);

export const stopWaitBoundMs = (reported: ReadonlyArray<number | undefined>): number =>
  reported.reduce<number>((largest, bound) => Math.max(largest, bound ?? STOP_WAIT_WHEN_UNKNOWN_MS), 0);

export const STOP_MESSAGE_MAX_BYTES = 256;

export const STOP_MESSAGE_OVERLONG_REASON = `the line is longer than ${STOP_MESSAGE_MAX_BYTES} bytes`;

const STOP_MESSAGE_EVENT = 'stop';

const STOP_MESSAGE_FIELDS: ReadonlySet<string> = new Set(['event', ...STOP_VALUE_NAMES]);

export const formatStopMessage = (values: StopValues): string =>
  `${JSON.stringify({ event: STOP_MESSAGE_EVENT, closeGraceMs: values.closeGraceMs, managedServerStopGraceMs: values.managedServerStopGraceMs, drainTimeoutMs: values.drainTimeoutMs, mcpCloseGraceMs: values.mcpCloseGraceMs })}\n`;

export type StopMessage = { kind: 'stop'; values: StopValues } | { kind: 'malformed'; reason: string };

export const parseStopMessage = (line: string): StopMessage => {
  if (Buffer.byteLength(line, 'utf8') > STOP_MESSAGE_MAX_BYTES) return { kind: 'malformed', reason: STOP_MESSAGE_OVERLONG_REASON };
  let parsed: unknown;
  try {
    parsed = parseOutsideJson(line);
  } catch (error) {
    return { kind: 'malformed', reason: `the line is not JSON within the allowed depth: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { kind: 'malformed', reason: 'the line is not a JSON object' };
  const record = parsed as Readonly<Record<string, unknown>>;
  if (record['event'] !== STOP_MESSAGE_EVENT) return { kind: 'malformed', reason: `the event is not "${STOP_MESSAGE_EVENT}"` };
  const extra = Object.keys(record).filter((key) => !STOP_MESSAGE_FIELDS.has(key));
  if (extra.length > 0) return { kind: 'malformed', reason: `unknown fields: ${extra.join(', ')}` };
  const values = parseStopValues(record);
  return values.kind === 'values' ? { kind: 'stop', values: values.values } : { kind: 'malformed', reason: values.reason };
};

export const PLATFORM_CHILD_ENV_NAMES: Readonly<Record<'win32', readonly string[]>> = {
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
  const extra = platform === 'win32' ? PLATFORM_CHILD_ENV_NAMES[platform] : [];
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
  data?: Readonly<Record<string, LogValue>>;
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

export const RESERVED_LOG_KEYS = ['ts', 'level', 'service', 'pid', 'msg', 'runId', 'workerId', 'traceId', 'step', 'count', 'ids', 'err'] as const;

export type ReservedLogKey = (typeof RESERVED_LOG_KEYS)[number];

export type LogValue = string | number | boolean | null | readonly string[];

export type EventPayload = Readonly<Record<string, LogValue>> & { readonly [K in ReservedLogKey]?: never };

export const LOG_LIST_MAX_ITEMS = 64;
export const LOG_ITEM_MAX_CHARS = 64;

const RESERVED_LOG_KEY_SET: ReadonlySet<string> = new Set(RESERVED_LOG_KEYS);

type WrittenLogValue = string | number | boolean | null | string[];

const extraFields = (data: NonNullable<LogFields['data']>): Record<string, WrittenLogValue> => {
  const written: Record<string, WrittenLogValue> = {};
  for (const [key, value] of Object.entries(data)) {
    if (RESERVED_LOG_KEY_SET.has(key)) continue;
    if (typeof value !== 'object' || value === null) {
      written[key] = value;
      continue;
    }
    written[key] = value.slice(0, LOG_LIST_MAX_ITEMS).map((item) => item.slice(0, LOG_ITEM_MAX_CHARS));
    if (value.length > LOG_LIST_MAX_ITEMS) written[`${key}Omitted`] = value.length - LOG_LIST_MAX_ITEMS;
  }
  return written;
};

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

export const withLogData = (logger: JsonLogger, data: NonNullable<LogFields['data']>): JsonLogger => {
  const merged = (fields: LogFields | undefined): LogFields => ({ ...fields, data: { ...data, ...fields?.data } });
  return {
    debug: (msg, fields) => logger.debug(msg, merged(fields)),
    info: (msg, fields) => logger.info(msg, merged(fields)),
    warn: (msg, fields) => logger.warn(msg, merged(fields)),
    error: (msg, fields) => logger.error(msg, merged(fields)),
  };
};

export const declaredChildEnv = (source: Readonly<Record<string, string | undefined>>, names: readonly string[]): Readonly<Record<string, string>> => {
  const env: Record<string, string> = {};
  for (const name of names) {
    const value = source[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
};
