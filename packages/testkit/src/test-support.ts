import { spawn } from './child-process.ts';
import type { ChildProcess, SpawnOptions } from './child-process.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { TestContext } from 'vitest';
import { FIRST_GENERATION, SOCKET_PATH_LIMIT, forceKillGroup, generationLayout, isProcessAlive, shortTempBase } from '@momonga/foundation';
import { stopSupervisorHolder } from './process-groups.ts';

export const TEST_RUN_ENV = 'MOMONGA_TEST_RUN';
export const TEMP_DIR_PREFIX = 'mmt-';
export const TEST_HEARTBEAT_MS = 10_000;
export const REAL_PROCESS_TEST_TIMEOUT_MS = 90_000;

const PROCESS_KILL_DEADLINE_MS = 5000;

export const realProcessTestSignal = (): AbortSignal => AbortSignal.timeout(REAL_PROCESS_TEST_TIMEOUT_MS);

export const testRunToken = (): string => {
  const token = process.env[TEST_RUN_ENV];
  if (token === undefined) throw new Error(`${TEST_RUN_ENV} is not set; run through a vitest project whose global setup sets the run token`);
  return token;
};

export const tempDirPrefixFor = (token: string): string => `${TEMP_DIR_PREFIX}${token}-`;

type Cleanup = () => void | Promise<void>;

export type CleanupContext = Pick<TestContext, 'onTestFinished'>;

function assertTestContext(context: CleanupContext | undefined, helper: string): asserts context is CleanupContext {
  if (typeof context?.onTestFinished !== 'function') {
    throw new Error(
      `${helper} needs a test context with onTestFinished: receive it as the last argument of the test function, for example it('...', (context) => ...)`,
    );
  }
}

export const registerCleanup = (context: CleanupContext | undefined, cleanup: Cleanup, boundMs?: number): void => {
  assertTestContext(context, 'registerCleanup');
  context.onTestFinished(cleanup, boundMs);
};

const longestSocketOf = (home: string): string => {
  const sockets = Object.values(generationLayout(home, FIRST_GENERATION, 'darwin').sockets);
  return sockets.reduce((longest, socket) => (Buffer.byteLength(socket) > Buffer.byteLength(longest) ? socket : longest));
};

export const assertHomeSocketBudget = (home: string): void => {
  const socket = longestSocketOf(home);
  const length = Buffer.byteLength(socket);
  if (length < SOCKET_PATH_LIMIT) return;
  throw new Error(
    `home ${home} leaves no socket-path budget: ${socket} is ${length} bytes, the limit is ${SOCKET_PATH_LIMIT - 1} bytes (budget ${SOCKET_PATH_LIMIT - 1 - length})`,
  );
};

const restoreWritable = (target: string): void => {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(target);
  } catch {
    return;
  }
  if (!stat.isDirectory()) return;
  fs.chmodSync(target, 0o700);
  for (const entry of fs.readdirSync(target)) restoreWritable(path.join(target, entry));
};

const removeDirectoryTree = (dir: string): void => {
  restoreWritable(dir);
  fs.rmSync(dir, { recursive: true, force: true });
  if (fs.existsSync(dir)) throw new Error(`test temp dir ${dir} still exists after cleanup`);
};

export type TempDirOptions = { asHome?: boolean };

const tempDirBase = (asHome: boolean): string => (asHome ? shortTempBase(process.platform) : os.tmpdir());

export const testTempBases = (): string[] => [...new Set([tempDirBase(true), tempDirBase(false)].map((base) => fs.realpathSync(base)))];

export const isUnderTestTempBase = (dir: string): boolean => testTempBases().some((base) => dir.startsWith(`${base}${path.sep}`));

const createdHomes = new Set<string>();

export const createTempDir = (options: TempDirOptions = {}): string => {
  const asHome = options.asHome === true;
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(tempDirBase(asHome), tempDirPrefixFor(testRunToken()))));
  fs.chmodSync(dir, 0o700);
  if (!asHome) return dir;
  try {
    assertHomeSocketBudget(dir);
  } catch (error) {
    removeDirectoryTree(dir);
    throw error;
  }
  createdHomes.add(dir);
  return dir;
};

export const removeTempDir = async (dir: string): Promise<void> => {
  if (createdHomes.delete(dir)) await stopSupervisorHolder(dir);
  removeDirectoryTree(dir);
};

export const withTempDir = (context: CleanupContext | undefined, options: TempDirOptions = {}): string => {
  assertTestContext(context, 'withTempDir');
  const dir = createTempDir(options);
  context.onTestFinished(() => removeTempDir(dir));
  return dir;
};

type Closable = { close: () => Promise<unknown> };

export const closeOnceStarted =
  <Handle extends Closable>(started: Promise<Handle>): (() => Promise<void>) =>
  async () => {
    const handle = await started.catch(() => undefined);
    await handle?.close();
  };

export const ownedStart = <Handle extends Closable>(context: CleanupContext | undefined, started: Promise<Handle>): Promise<Handle> => {
  started.catch(() => undefined);
  registerCleanup(context, closeOnceStarted(started), REAL_PROCESS_TEST_TIMEOUT_MS);
  return started;
};

export type TrackedChild = ChildProcess & { readonly pid: number };

const waitForExit = (child: ChildProcess): Promise<void> =>
  new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    const timer = setTimeout(() => reject(new Error(`child ${child.pid} did not exit within ${PROCESS_KILL_DEADLINE_MS} ms`)), PROCESS_KILL_DEADLINE_MS);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });

const killTracked = async (child: TrackedChild, ownGroup: boolean): Promise<void> => {
  if (ownGroup) {
    const gone = await forceKillGroup(child.pid, { deadline: Date.now() + PROCESS_KILL_DEADLINE_MS });
    if (!gone) throw new Error(`cleanup could not kill process group ${child.pid}`);
  } else if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
  }
  await waitForExit(child);
  if (isProcessAlive(child.pid)) throw new Error(`tracked child ${child.pid} is still alive after cleanup`);
};

export const spawnTracked = (context: CleanupContext | undefined, command: string, args: readonly string[] = [], options: SpawnOptions = {}): TrackedChild => {
  assertTestContext(context, 'spawnTracked');
  const ownGroup = options.detached ?? true;
  const child = spawn(command, args, { ...options, detached: ownGroup });
  const pid = child.pid;
  if (pid === undefined) throw new Error(`spawn of ${command} failed`);
  const tracked = child as TrackedChild;
  context.onTestFinished(() => killTracked(tracked, ownGroup));
  return tracked;
};
