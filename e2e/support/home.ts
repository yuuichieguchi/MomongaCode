import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach } from 'vitest';
import { FIRST_GENERATION, SOCKET_PATH_LIMIT, ensureMomongaDirs, generationLayout, isProcessAlive, momongaPaths } from '@momonga/foundation';
import type { MomongaPaths } from '@momonga/foundation';
import { stopSupervisorHolder } from '@momonga/testkit';
import { createProcessLedger } from './ledger.ts';
import type { ProcessLedger } from './ledger.ts';
import { groupAlive } from './process.ts';
import { removeTree } from './remove-tree.ts';
import { E2E_RUN_ENV, E2E_RUN_PATTERN, LIVE_MARKER_SUFFIX, PIDS_FILE_SUFFIX, e2eEntryPrefix, harnessFilePath } from './run-env.ts';
import { E2E_DISPOSE_BOUND_MS, withinBound } from './wait.ts';

export { E2E_DIR_PREFIX, E2E_RUN_ENV, E2E_RUN_PATTERN, LIVE_MARKER_SUFFIX, PIDS_FILE_SUFFIX } from './run-env.ts';
export const PROJECT_DIR_NAME = 'p';
export const SESSION_TMP_DIR_NAME = 'session-tmp';
export const UPSTREAM_SOCKET_NAME = 'u.sock';
export const MCP_RECORD_FILE_NAME = 'mcp.rec';
export const GRANDCHILD_READY_FILE_NAME = 'gc.ready';
export const OVERLAP_MESSAGE = 'e2e files overlap';

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

export type CreateE2eHomeOptions = { tmpRoot?: string; run?: string };

export type E2eCleanup = () => void | Promise<void>;

const ROOT_SUFFIX_PLACEHOLDER = 'xxxxxx';
const PRIVATE_DIRECTORY_MODE = 0o700;
const MARKER_FILE_MODE = 0o600;

const cleanups: E2eCleanup[] = [];
const homes: E2eHome[] = [];

export const e2eTmpRoot = (): string => fs.realpathSync(os.tmpdir());

const runTokenFrom = (value: string | undefined): string => {
  if (value === undefined) throw new Error(`${E2E_RUN_ENV} is not set; the e2e global setup did not run`);
  if (!E2E_RUN_PATTERN.test(value)) throw new Error(`${E2E_RUN_ENV} must be 4 lowercase hex characters, got ${JSON.stringify(value)}`);
  return value;
};

export const e2eRunToken = (env: Readonly<Record<string, string | undefined>> = process.env): string => runTokenFrom(env[E2E_RUN_ENV]);

export const liveMarkerPath = (tmpRoot: string, run: string): string => harnessFilePath(tmpRoot, run, LIVE_MARKER_SUFFIX);

export const pidsFilePath = (tmpRoot: string, run: string): string => harnessFilePath(tmpRoot, run, PIDS_FILE_SUFFIX);

export const assertInside = (candidate: string, container: string): void => {
  const relative = path.relative(container, candidate);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(`e2e tmp root ${candidate} is outside the real temp dir ${container}`);
};

const longestSocketBytes = (tmpRoot: string, run: string): number => {
  const sockets = Object.values(generationLayout(path.join(tmpRoot, `${e2eEntryPrefix(run)}${ROOT_SUFFIX_PLACEHOLDER}`), FIRST_GENERATION).sockets);
  return Math.max(...sockets.map((socket) => Buffer.byteLength(socket)));
};

const assertSocketBudget = (tmpRoot: string, run: string): void => {
  const longest = longestSocketBytes(tmpRoot, run);
  const maximum = SOCKET_PATH_LIMIT - 1;
  if (longest > maximum) throw new Error(`longest socket must be at most ${maximum} bytes in ${tmpRoot}, got ${longest}`);
};

const writeLiveMarker = (marker: string): void => {
  fs.writeFileSync(marker, String(process.pid), { flag: 'wx', mode: MARKER_FILE_MODE });
};

const markerOwnerOf = (marker: string): number | undefined => {
  const text = fs.readFileSync(marker, 'utf8').trim();
  return /^\d+$/.test(text) ? Number(text) : undefined;
};

const acquireLiveMarker = (marker: string): void => {
  try {
    writeLiveMarker(marker);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const owner = markerOwnerOf(marker);
  if (owner !== undefined && owner !== process.pid && isProcessAlive(owner)) throw new Error(`${OVERLAP_MESSAGE}: ${marker} is held by live process ${owner}`);
  fs.rmSync(marker);
  writeLiveMarker(marker);
};

export const createE2eHome = async (options: CreateE2eHomeOptions = {}): Promise<E2eHome> => {
  const run = options.run === undefined ? e2eRunToken() : runTokenFrom(options.run);
  const realTmp = e2eTmpRoot();
  const tmpRoot = options.tmpRoot === undefined ? realTmp : fs.realpathSync(options.tmpRoot);
  assertInside(tmpRoot, realTmp);
  assertSocketBudget(tmpRoot, run);
  acquireLiveMarker(liveMarkerPath(tmpRoot, run));
  const root = fs.mkdtempSync(path.join(tmpRoot, e2eEntryPrefix(run)));
  if (root === os.userInfo().homedir) throw new Error(`refusing to use the user home ${root} as an e2e home`);
  const paths = momongaPaths(root);
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

export const registerE2eCleanup = (cleanup: E2eCleanup): void => {
  cleanups.push(cleanup);
};

const supervisorGroupsOf = (home: E2eHome): number[] => home.ledger.entries().filter((entry) => entry.source === 'supervisor').map((entry) => entry.pgid);

const stopProcessesOf = async (home: E2eHome): Promise<void> => {
  await home.ledger.collect({});
  const supervisors = supervisorGroupsOf(home);
  if (supervisors.length > 0) await home.ledger.kill(supervisors);
  await home.ledger.sweep({});
};

const removeHome = async (home: E2eHome): Promise<void> => {
  await stopSupervisorHolder(home.root);
  removeTree(home.root);
  fs.rmSync(liveMarkerPath(home.tmpRoot, home.run), { force: true });
  if (fs.existsSync(home.root)) throw new Error(`e2e root ${home.root} still exists after removal`);
};

const survivingGroups = (disposing: readonly E2eHome[]): number[] =>
  disposing.flatMap((home) => home.ledger.entries().map((entry) => entry.pgid).filter((pgid) => groupAlive(pgid)));

export const disposeAll = async (): Promise<void> => {
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
    for (const home of disposing) await attempt(() => stopProcessesOf(home));
    for (const callback of callbacks) await attempt(callback);
    for (const home of disposing) await attempt(() => removeHome(home));
  };
  try {
    await withinBound(work(), E2E_DISPOSE_BOUND_MS, 'disposeAll');
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}; surviving process groups: ${survivingGroups(disposing).join(', ') || 'none'}`, { cause: error });
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, `e2e cleanup failed ${failures.length} times`);
};

afterEach(disposeAll);
