import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ProbeFailedError, defaultProcessInspector, findHolders, isProcessAlive, judgeProcessIdentity, rotatedLogPath, valueOrThrow } from '@momonga/foundation';
import type { MomongaPaths, ProbeResult, StartTime } from '@momonga/foundation';
import type { SupervisorHealth } from '@momonga/protocol';
import { firstGeneration, killGroupsForCleanup } from '@momonga/testkit';
import { readDb } from './db.ts';
import { readLog } from './log-reader.ts';
import { appendHarnessFile } from './run-env.ts';

export const TOOL_GROUPS_SQL = 'SELECT pgid FROM idempotency WHERE pgid IS NOT NULL';
export const UNREACHABLE_ERRNO_CODES: ReadonlySet<string> = new Set(['ECONNREFUSED', 'ENOENT']);

export type LedgerSource = 'supervisor' | 'health' | 'supervisor-log' | 'db' | 'mcp-record' | 'fixture' | 'marker-holder';

export type LedgerEntry = { readonly pgid: number; readonly startTime: StartTime | undefined; readonly source: LedgerSource };

export type LedgerPorts = {
  startTimeOf: (pid: number) => Promise<ProbeResult<StartTime>>;
  groupAlive: (pgid: number) => boolean;
  pidAlive: (pid: number) => boolean;
  killGroups: (pgids: readonly number[]) => Promise<void>;
  findHolders: (marker: string) => Promise<number[]>;
  pgidOf: (pid: number) => Promise<number | undefined>;
};

export type LedgerCollectSources = {
  health?: () => Promise<SupervisorHealth>;
  paths?: MomongaPaths;
  recordFiles?: readonly string[];
};

export type ProcessLedger = {
  readonly pidsFile: string;
  add(pid: number, source: LedgerSource): Promise<void>;
  record(health: SupervisorHealth): Promise<void>;
  collect(sources: LedgerCollectSources): Promise<void>;
  entries(): readonly LedgerEntry[];
  kill(pgids?: readonly number[]): Promise<number[]>;
  sweep(sources: LedgerCollectSources): Promise<number[]>;
};

export type LedgerCheapSources = Omit<LedgerCollectSources, 'health'>;

export type CreateProcessLedgerOptions = { pidsFile: string; ports?: Partial<LedgerPorts>; sources?: LedgerCheapSources };

const LEDGER_SOURCES: ReadonlySet<string> = new Set<LedgerSource>(['supervisor', 'health', 'supervisor-log', 'db', 'mcp-record', 'fixture', 'marker-holder']);
const SPAWN_LOG_MESSAGES: ReadonlySet<string> = new Set(['child.spawn', 'child.ready']);
const markerDirectoriesOf = (paths: MomongaPaths): string[] => [paths.markers.tools, paths.markers.mcp, paths.markers.daemons, path.join(paths.markers.targets, 'fm')];
const RECORD_TYPES_WITH_PID: ReadonlySet<string> = new Set(['ready', 'grandchild']);
const PS_PATH = '/bin/ps';
const PIDS_FIELD_SEPARATOR = '\t';
const NO_START_TIME = '-';

const errnoCodeOf = (error: unknown): unknown => (typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined);

const isSource = (value: string): value is LedgerSource => LEDGER_SOURCES.has(value);

const readTextIfPresent = (file: string): string | undefined => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (errnoCodeOf(error) === 'ENOENT') return undefined;
    throw error;
  }
};

const listIfPresent = (directory: string): string[] => {
  try {
    return fs.readdirSync(directory);
  } catch (error) {
    if (errnoCodeOf(error) === 'ENOENT') return [];
    throw error;
  }
};

export const processGroupOf = (pid: number): Promise<number | undefined> =>
  new Promise((resolve, reject) => {
    execFile(PS_PATH, ['-o', 'pgid=', '-p', String(pid)], { env: { LC_ALL: 'C' } }, (error, stdout) => {
      if (error !== null && String(error.code) !== '1') {
        reject(error);
        return;
      }
      const text = stdout.trim();
      resolve(/^\d+$/.test(text) ? Number(text) : undefined);
    });
  });

export const defaultLedgerPorts: LedgerPorts = {
  startTimeOf: (pid) => defaultProcessInspector().startTimeOf(pid, { signal: new AbortController().signal }),
  groupAlive: (pgid) => isProcessAlive(-pgid),
  pidAlive: (pid) => isProcessAlive(pid),
  killGroups: killGroupsForCleanup,
  findHolders: (marker) => findHolders(marker, { signal: new AbortController().signal }),
  pgidOf: processGroupOf,
};

export const formatPidsLine = (entry: LedgerEntry): string => `${entry.pgid}${PIDS_FIELD_SEPARATOR}${entry.startTime ?? NO_START_TIME}${PIDS_FIELD_SEPARATOR}${entry.source}\n`;

const decimalStartTime = (text: string): StartTime | undefined => {
  if (!/^\d+$/.test(text)) return undefined;
  return BigInt(text);
};

export const parsePidsFile = (text: string): LedgerEntry[] =>
  text
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => {
      const [pgidText, startText, source, ...extra] = line.split(PIDS_FIELD_SEPARATOR);
      const pgid = Number(pgidText);
      const startTime = startText === undefined || startText === NO_START_TIME ? undefined : decimalStartTime(startText);
      if (extra.length > 0 || !Number.isInteger(pgid) || pgid <= 1 || startText === undefined || (startText !== NO_START_TIME && startTime === undefined) || source === undefined || !isSource(source)) {
        throw new Error(`malformed pids line: ${line}`);
      }
      return { pgid, startTime, source };
    });

export type GroupSelection = { readonly signal: number[]; readonly dropped: number[] };

export const selectGroupsToSignal = async (entries: readonly LedgerEntry[], ports: Pick<LedgerPorts, 'startTimeOf' | 'groupAlive' | 'pidAlive'>): Promise<GroupSelection> => {
  const signal: number[] = [];
  const dropped: number[] = [];
  for (const entry of entries) {
    const identity = ports.pidAlive(entry.pgid) ? judgeProcessIdentity(entry.startTime, await ports.startTimeOf(entry.pgid)) : { kind: 'gone' as const };
    if (identity.kind === 'failed') throw new ProbeFailedError(`reading the start time of ${entry.pgid}`, identity);
    const signalable = identity.kind === 'same' ? true : identity.kind === 'replaced' ? false : ports.groupAlive(entry.pgid);
    (signalable ? signal : dropped).push(entry.pgid);
  }
  return { signal, dropped };
};

export const killSelectedGroups = async (signal: readonly number[], ports: Pick<LedgerPorts, 'groupAlive' | 'killGroups'>): Promise<void> => {
  if (signal.length === 0) return;
  await ports.killGroups(signal);
  const survivors = signal.filter((pgid) => ports.groupAlive(pgid));
  if (survivors.length > 0) throw new Error(`process groups survived the kill: ${survivors.join(', ')}`);
};

const pidsOfRecordFile = (text: string): number[] => {
  const lines = text.split('\n');
  const unterminated = lines.pop() ?? '';
  const pids: number[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    if (/^\d+$/.test(trimmed)) {
      pids.push(Number(trimmed));
      continue;
    }
    const record: unknown = JSON.parse(trimmed);
    if (typeof record === 'object' && record !== null && 'type' in record && typeof record.type === 'string' && RECORD_TYPES_WITH_PID.has(record.type) && 'pid' in record && typeof record.pid === 'number') {
      pids.push(record.pid);
    }
  }
  if (/^\d+$/.test(unterminated.trim())) pids.push(Number(unterminated.trim()));
  return pids;
};

export const createProcessLedger = (options: CreateProcessLedgerOptions): ProcessLedger => {
  const { pidsFile } = options;
  const ports: LedgerPorts = { ...defaultLedgerPorts, ...options.ports };
  const entries = new Map<number, LedgerEntry>();

  const add = async (pid: number, source: LedgerSource): Promise<void> => {
    if (entries.has(pid)) return;
    const entry: LedgerEntry = { pgid: pid, startTime: valueOrThrow(`reading the start time of ${pid}`, await ports.startTimeOf(pid), undefined), source };
    if (entries.has(pid)) return;
    entries.set(pid, entry);
    appendHarnessFile(pidsFile, formatPidsLine(entry));
  };

  const collectHealth = async (health: () => Promise<SupervisorHealth>): Promise<void> => {
    try {
      await recordHealth(await health());
    } catch (error) {
      if (!UNREACHABLE_ERRNO_CODES.has(String(errnoCodeOf(error)))) throw error;
    }
  };

  const collectSupervisorLogs = async (paths: MomongaPaths): Promise<void> => {
    const records = [...readLog(rotatedLogPath(paths.logFiles.supervisor, 1)), ...readLog(paths.logFiles.supervisor)];
    for (const entry of records) {
      if (SPAWN_LOG_MESSAGES.has(entry.msg) && typeof entry['childPid'] === 'number') await add(entry['childPid'], 'supervisor-log');
    }
  };

  const collectSupervisorLock = async (paths: MomongaPaths): Promise<void> => {
    const text = readTextIfPresent(firstGeneration(paths).locks.supervisor);
    const pid = text === undefined ? Number.NaN : Number.parseInt(text, 10);
    if (Number.isInteger(pid) && pid > 1) await add(pid, 'supervisor');
  };

  const collectDatabase = async (paths: MomongaPaths): Promise<void> => {
    for (const row of readDb(paths.databases.runtime, TOOL_GROUPS_SQL)) {
      if (typeof row['pgid'] === 'number') await add(row['pgid'], 'db');
    }
  };

  const collectRecordFiles = async (files: readonly string[]): Promise<void> => {
    for (const file of files) {
      const text = readTextIfPresent(file);
      if (text === undefined) continue;
      for (const pid of pidsOfRecordFile(text)) await add(pid, 'mcp-record');
    }
  };

  const collectMarkerHolders = async (paths: MomongaPaths): Promise<void> => {
    for (const directory of markerDirectoriesOf(paths)) {
      for (const marker of listIfPresent(directory)) {
        for (const holder of await ports.findHolders(path.join(directory, marker))) {
          const pgid = await ports.pgidOf(holder);
          if (pgid !== undefined) await add(pgid, 'marker-holder');
        }
      }
    }
  };

  const resolvedSources = ({ paths, recordFiles }: LedgerCheapSources): LedgerCheapSources => {
    const resolvedPaths = paths ?? options.sources?.paths;
    const resolvedRecordFiles = recordFiles ?? options.sources?.recordFiles;
    return {
      ...(resolvedPaths === undefined ? {} : { paths: resolvedPaths }),
      ...(resolvedRecordFiles === undefined ? {} : { recordFiles: resolvedRecordFiles }),
    };
  };

  const perPollSteps = ({ paths, recordFiles }: LedgerCheapSources): (() => Promise<void>)[] => [
    ...(paths === undefined ? [] : [() => collectSupervisorLock(paths), () => collectSupervisorLogs(paths), () => collectDatabase(paths)]),
    ...(recordFiles === undefined ? [] : [() => collectRecordFiles(recordFiles)]),
  ];

  const cheapSourcesOf = (sources: LedgerCheapSources): (() => Promise<void>)[] => {
    const { paths } = sources;
    return [...perPollSteps(sources), ...(paths === undefined ? [] : [() => collectMarkerHolders(paths)])];
  };

  const gatherFailures = async (steps: readonly (() => Promise<void>)[]): Promise<unknown[]> => {
    const failures: unknown[] = [];
    for (const step of steps) {
      try {
        await step();
      } catch (error) {
        failures.push(error);
      }
    }
    return failures;
  };

  const raise = (failures: readonly unknown[]): void => {
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, `ledger collection failed ${failures.length} times`);
  };

  const recordHealth = async (health: SupervisorHealth): Promise<void> => {
    for (const child of health.children) {
      if (child.pid !== undefined) await add(child.pid, 'health');
    }
  };

  const retainedFailures: unknown[] = [];

  const record = async (health: SupervisorHealth): Promise<void> => {
    retainedFailures.push(...(await gatherFailures([() => recordHealth(health), ...perPollSteps(options.sources ?? {})])));
  };

  const collectSteps = ({ health, ...cheap }: LedgerCollectSources): (() => Promise<void>)[] => [
    ...(health === undefined ? [] : [() => collectHealth(health)]),
    ...cheapSourcesOf(resolvedSources(cheap)),
  ];

  const collect = async (sources: LedgerCollectSources): Promise<void> => {
    raise(await gatherFailures(collectSteps(sources)));
  };

  const kill = async (pgids?: readonly number[]): Promise<number[]> => {
    const targets = pgids === undefined ? [...entries.values()] : pgids.flatMap((pgid) => entries.get(pgid) ?? []);
    const { signal, dropped } = await selectGroupsToSignal(targets, ports);
    for (const pgid of dropped) entries.delete(pgid);
    await killSelectedGroups(signal, ports);
    return signal;
  };

  const sweep = async (sources: LedgerCollectSources): Promise<number[]> => {
    const collectFailures = await gatherFailures(collectSteps(sources));
    const killed = await kill();
    raise([...retainedFailures.splice(0), ...collectFailures]);
    return killed;
  };

  return { pidsFile, add, record, collect, entries: () => [...entries.values()], kill, sweep };
};
