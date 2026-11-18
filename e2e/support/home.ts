import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach } from 'vitest';
import { FIRST_GENERATION, assertUnixSocketPathFits, ensureMomongaDirs, generationLayout, momongaPaths, scopeToGeneration, systemTiming } from '@momonga/foundation';
import type { MomongaPaths } from '@momonga/foundation';
import { createTempDir, stopSupervisorHolders } from '@momonga/testkit';
import { createProcessLedger } from './ledger.ts';
import type { LedgerSurvivor, ProcessLedger } from './ledger.ts';
import { readDb } from './db.ts';
import { groupSignalable } from './process.ts';
import { removeTree } from './remove-tree.ts';
import { E2E_RUN_ENV, E2E_RUN_PATTERN, KEPT_HOME_FILE_NAME, PIDS_FILE_SUFFIX, e2eEntryPrefix, e2eTmpRoot, harnessFilePath, privateTempRoot } from './run-env.ts';
import { E2E_DISPOSE_BOUND_MS, E2E_STOP_SETTLED_BOUNDS_MS, UNTIL_DEFAULT_INTERVAL_MS, abortableWait, withinBound } from './wait.ts';

export { E2E_DIR_PREFIX, E2E_RUN_ENV, E2E_RUN_PATTERN, KEPT_HOME_FILE_NAME, PIDS_FILE_SUFFIX, e2eTmpRoot } from './run-env.ts';
export const PROJECT_DIR_NAME = 'p';
export const SESSION_TMP_DIR_NAME = 'session-tmp';
export const UPSTREAM_SOCKET_NAME = 'u.sock';
export const MCP_RECORD_FILE_NAME = 'mcp.rec';
export const GRANDCHILD_READY_FILE_NAME = 'gc.ready';

export type E2eHome = {
  readonly run: string;
  readonly tmpRoot: string;
  readonly root: string;
  readonly home: string;
  readonly project: string;
  readonly sessionTmp: string;
  readonly upstreamSocket: string;
  readonly paths: MomongaPaths;
  readonly ledger: ProcessLedger;
};

export type CreateE2eHomeOptions = { tmpRoot?: string; run?: string; privateBase?: string };

export type E2eTestOutcome = { readonly test: string; readonly failed: boolean };

export type E2eCleanup = () => void | Promise<void>;

const ROOT_SUFFIX_PLACEHOLDER = 'xxxxxx';
const PRIVATE_DIRECTORY_MODE = 0o700;

const cleanups: E2eCleanup[] = [];
const homes: E2eHome[] = [];

const runTokenFrom = (value: string | undefined): string => {
  if (value === undefined) throw new Error(`${E2E_RUN_ENV} is not set; the e2e global setup did not run`);
  if (!E2E_RUN_PATTERN.test(value)) throw new Error(`${E2E_RUN_ENV} must be 4 lowercase hex characters, got ${JSON.stringify(value)}`);
  return value;
};

export const e2eRunToken = (env: Readonly<Record<string, string | undefined>> = process.env): string => runTokenFrom(env[E2E_RUN_ENV]);

export const pidsFilePath = (tmpRoot: string, run: string): string => harnessFilePath(tmpRoot, run, PIDS_FILE_SUFFIX);

export const assertInside = (candidate: string, container: string): void => {
  const relative = path.relative(container, candidate);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(`e2e tmp root ${candidate} is outside the real temp dir ${container}`);
};

const longestSocketBytes = (tmpRoot: string, run: string): number => {
  const sockets = Object.values(generationLayout(path.join(tmpRoot, `${e2eEntryPrefix(run)}${ROOT_SUFFIX_PLACEHOLDER}`), FIRST_GENERATION).sockets);
  return Math.max(...sockets.map((socket) => Buffer.byteLength(socket)));
};

const assertSocketBudget = async (tmpRoot: string, run: string): Promise<void> => {
  const longest = longestSocketBytes(tmpRoot, run);
  const standIn = path.join(tmpRoot, 's'.repeat(longest - Buffer.byteLength(tmpRoot) - 1));
  try {
    await assertUnixSocketPathFits(standIn);
  } catch (error) {
    throw new Error(`the longest socket of a home in ${tmpRoot} is ${longest} bytes, which leaves no socket-path budget`, { cause: error });
  }
};

export const createE2eHome = async (options: CreateE2eHomeOptions = {}): Promise<E2eHome> => {
  const run = options.run === undefined ? e2eRunToken() : runTokenFrom(options.run);
  const realTmp = options.privateBase === undefined ? e2eTmpRoot() : privateTempRoot(fs.realpathSync(options.privateBase));
  const tmpRoot = options.tmpRoot === undefined ? realTmp : fs.realpathSync(options.tmpRoot);
  assertInside(tmpRoot, realTmp);
  await assertSocketBudget(tmpRoot, run);
  const root = createTempDir({ parent: tmpRoot, prefix: e2eEntryPrefix(run) });
  if (root === os.userInfo().homedir) throw new Error(`refusing to use the user home ${root} as an e2e home`);
  const paths = momongaPaths(root, process.platform, process.env);
  await ensureMomongaDirs(paths);
  const project = path.join(root, PROJECT_DIR_NAME);
  const sessionTmp = path.join(root, SESSION_TMP_DIR_NAME);
  for (const directory of [project, sessionTmp]) {
    fs.mkdirSync(directory, { mode: PRIVATE_DIRECTORY_MODE });
    fs.chmodSync(directory, PRIVATE_DIRECTORY_MODE);
  }
  const home: E2eHome = {
    run,
    tmpRoot,
    root,
    home: root,
    project,
    sessionTmp,
    upstreamSocket: path.join(root, UPSTREAM_SOCKET_NAME),
    paths,
    ledger: createProcessLedger({
      pidsFile: pidsFilePath(tmpRoot, run),
      sources: { paths, recordFiles: [path.join(root, MCP_RECORD_FILE_NAME), path.join(root, GRANDCHILD_READY_FILE_NAME)] },
    }),
  };
  homes.push(home);
  return home;
};

export const markersOf = (home: Pick<E2eHome, 'paths'>, generation: number = FIRST_GENERATION): MomongaPaths['markers'] => scopeToGeneration(home.paths, generation).markers;

export const registerE2eCleanup = (cleanup: E2eCleanup): void => {
  cleanups.push(cleanup);
};

export type E2eStopBounds = { readonly supervisorAsked: number; readonly orphaned: number };

const LOG_TAIL_BYTES = 16 * 1024;
const JOURNAL_TAIL_ROWS = 40;
const JOURNAL_PAYLOAD_CHARS = 240;
const JOURNAL_TAIL_SQL = `SELECT run_id, seq, type, created_at, substr(payload_json, 1, ${JOURNAL_PAYLOAD_CHARS}) AS payload FROM events ORDER BY id DESC LIMIT ${JOURNAL_TAIL_ROWS}`;

const liveSupervisorsOf = (home: E2eHome): number[] => home.ledger.entries().filter((entry) => entry.source === 'supervisor' && groupSignalable(entry.pgid)).map((entry) => entry.pgid);

type StopReading = { readonly survivors: LedgerSurvivor[]; readonly collectFailure: unknown };

const readSurvivors = async (home: E2eHome): Promise<StopReading> => {
  let collectFailure: unknown;
  try {
    await home.ledger.collect({});
  } catch (error) {
    collectFailure = error;
  }
  return { survivors: await home.ledger.survivors(), collectFailure };
};

const survivorsAfterStop = async (home: E2eHome, bounds: E2eStopBounds): Promise<LedgerSurvivor[]> => {
  const first = await readSurvivors(home);
  const supervisors = liveSupervisorsOf(home);
  for (const pid of supervisors) process.kill(pid, 'SIGTERM');
  const deadline = systemTiming.monotonicMs() + (supervisors.length > 0 ? bounds.supervisorAsked : bounds.orphaned);
  let reading = first;
  while ((reading.survivors.length > 0 || reading.collectFailure !== undefined) && systemTiming.monotonicMs() < deadline) {
    await abortableWait(UNTIL_DEFAULT_INTERVAL_MS);
    reading = await readSurvivors(home);
  }
  if (reading.collectFailure !== undefined) throw reading.collectFailure;
  return reading.survivors;
};

const survivorErrors = (outcome: E2eTestOutcome, survivors: readonly LedgerSurvivor[]): Error[] =>
  survivors.map((survivor) => new Error(`${outcome.test} left process group ${survivor.pgid} alive after the product was asked to stop: ${survivor.command} (found by ${survivor.source})`));

const stopProcessesOf = async (home: E2eHome, outcome: E2eTestOutcome, bounds: E2eStopBounds): Promise<Error[]> => {
  const errors = survivorErrors(outcome, await survivorsAfterStop(home, bounds));
  await home.ledger.sweep({});
  return errors;
};

const tailOf = (file: string): string => {
  if (!fs.existsSync(file)) return `${file} does not exist`;
  const bytes = fs.readFileSync(file);
  return bytes.subarray(Math.max(0, bytes.length - LOG_TAIL_BYTES)).toString('utf8');
};

const journalTailOf = (home: E2eHome): string => {
  const database = home.paths.databases.runtime;
  if (!fs.existsSync(database)) return `${database} does not exist`;
  try {
    return readDb(database, JOURNAL_TAIL_SQL)
      .reverse()
      .map((row) => `${String(row['run_id'])} #${String(row['seq'])} ${new Date(Number(row['created_at'])).toISOString()} ${String(row['type'])} ${String(row['payload'])}`)
      .join('\n');
  } catch (error) {
    return `the journal could not be read: ${error instanceof Error ? error.message : String(error)}`;
  }
};

const productLogsOf = (home: E2eHome): string =>
  [
    ...Object.entries(home.paths.logFiles).map(([role, file]) => `--- ${role} log (tail) ---\n${tailOf(file)}`),
    `--- run journal (last ${JOURNAL_TAIL_ROWS} events) ---\n${journalTailOf(home)}`,
  ].join('\n');

const keepHome = (home: E2eHome, outcome: E2eTestOutcome): Error => {
  fs.writeFileSync(path.join(home.root, KEPT_HOME_FILE_NAME), `${outcome.test}\n`, { mode: 0o600 });
  return new Error(`${outcome.test} failed; its home is kept at ${home.root}\n${productLogsOf(home)}`);
};

const removeHome = async (home: E2eHome): Promise<void> => {
  await stopSupervisorHolders(home.root);
  removeTree(home.root);
  if (fs.existsSync(home.root)) throw new Error(`e2e root ${home.root} still exists after removal`);
};

const survivingGroups = (disposing: readonly E2eHome[]): number[] =>
  disposing.flatMap((home) => home.ledger.entries().map((entry) => entry.pgid).filter((pgid) => groupSignalable(pgid)));

export const disposeAll = async (outcome: E2eTestOutcome, bounds: E2eStopBounds = E2E_STOP_SETTLED_BOUNDS_MS): Promise<void> => {
  const disposing = homes.splice(0);
  const callbacks = cleanups.splice(0);
  const failures: unknown[] = [];
  const attempt = async (step: () => void | Promise<void>): Promise<void> => {
    try {
      await step();
    } catch (error) {
      failures.push(error);
    }
  };
  const work = async (): Promise<void> => {
    await Promise.all(disposing.map((home) => attempt(async () => {
      failures.push(...(await stopProcessesOf(home, outcome, bounds)));
    })));
    for (const callback of callbacks) await attempt(callback);
    const keep = outcome.failed || failures.length > 0;
    for (const home of disposing) await attempt(async () => {
      if (keep) throw keepHome(home, { test: outcome.test, failed: true });
      await removeHome(home);
    });
  };
  try {
    await withinBound(work(), E2E_DISPOSE_BOUND_MS, 'disposeAll');
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}; surviving process groups: ${survivingGroups(disposing).join(', ') || 'none'}`, { cause: error });
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, `e2e cleanup failed ${failures.length} times: ${failures.map((failure) => (failure instanceof Error ? failure.message : String(failure))).join('\n')}`);
};

afterEach((context) => disposeAll({ test: context.task.name, failed: context.task.result?.state === 'fail' }));
