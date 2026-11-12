import { spawn } from './child-process.ts';
import type { ChildProcess, SpawnOptions } from './child-process.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { TestContext } from 'vitest';
import { FIRST_GENERATION, SocketPathUnsupportedError, assertUnixSocketPathFits, forceKillGroup, generationLayout, isProcessAlive, systemWaitTiming, shortTempBase } from '@momonga/foundation';
import { stopSupervisorHolders } from './process-groups.ts';

export const TEST_RUN_ENV = 'MOMONGA_TEST_RUN';
export const TEMP_DIR_PREFIX = 'mmt-';
export const TEST_HEARTBEAT_MS = 10_000;
export const REAL_PROCESS_TEST_TIMEOUT_MS = 90_000;

export const SOURCE_SCAN_TEST_TIMEOUT_MS = REAL_PROCESS_TEST_TIMEOUT_MS;

export const SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS = 4 * REAL_PROCESS_TEST_TIMEOUT_MS;
export const SOLVER_MULTI_QUERY_TEST_TIMEOUT_MS = 6 * REAL_PROCESS_TEST_TIMEOUT_MS;
export const SOLVER_ENCODING_SWEEP_TEST_TIMEOUT_MS = 10 * REAL_PROCESS_TEST_TIMEOUT_MS;

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

const pathOfLengthIn = (directory: string, byteLength: number): string => path.join(directory, 's'.repeat(byteLength - Buffer.byteLength(directory) - 1));

export const assertHomeSocketBudget = async (home: string): Promise<void> => {
  const socket = longestSocketOf(home);
  const length = Buffer.byteLength(socket);
  try {
    await assertUnixSocketPathFits(pathOfLengthIn(home, length));
  } catch (error) {
    throw new Error(`home ${home} leaves no socket-path budget: ${socket} is ${length} bytes`, { cause: error });
  }
};

export const firstRefusedSocketPathBytes = async (directory: string): Promise<number> => {
  for (let byteLength = Buffer.byteLength(directory) + 2; ; byteLength += 1) {
    try {
      await assertUnixSocketPathFits(pathOfLengthIn(directory, byteLength));
    } catch (error) {
      if (error instanceof SocketPathUnsupportedError) return byteLength;
      throw error;
    }
  }
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

export type TempDirOptions = { asHome?: boolean; parent?: string };

export const systemTempRoot = (): string => fs.realpathSync(os.tmpdir());

const tempDirBase = (asHome: boolean): string => (asHome ? shortTempBase(process.platform, os.tmpdir()) : systemTempRoot());

export const testTempBases = (): string[] => [...new Set([tempDirBase(true), tempDirBase(false)].map((base) => fs.realpathSync(base)))];

export const isUnderTestTempBase = (dir: string): boolean => testTempBases().some((base) => dir.startsWith(`${base}${path.sep}`));

const createdHomes = new Set<string>();

export const createTempDir = (options: TempDirOptions = {}): string => {
  const asHome = options.asHome === true;
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(options.parent ?? tempDirBase(asHome), tempDirPrefixFor(testRunToken()))));
  fs.chmodSync(dir, 0o700);
  if (!asHome) return dir;
  createdHomes.add(dir);
  return dir;
};

export const removeTempDir = async (dir: string): Promise<void> => {
  if (createdHomes.delete(dir)) await stopSupervisorHolders(dir);
  removeDirectoryTree(dir);
};

export const withTempDir = (context: CleanupContext | undefined, options: TempDirOptions = {}): string => {
  assertTestContext(context, 'withTempDir');
  const dir = createTempDir(options);
  context.onTestFinished(() => removeTempDir(dir));
  return dir;
};

type Closable = { close: () => Promise<unknown> };

export type SettledBeforeCleanup<Result> = Result extends PromiseLike<unknown> ? never : Result;

export type CleanupRegistrar = (cleanup: () => Promise<void>) => void;

export type CleanupOwner = CleanupContext | CleanupRegistrar | undefined;

const isCleanupContext = (owner: CleanupOwner): owner is CleanupContext => typeof (owner as Partial<CleanupContext> | undefined)?.onTestFinished === 'function';

export function registerOwned<Handle extends Closable>(owner: CleanupOwner, start: () => Promise<Handle>): Promise<Handle>;
export function registerOwned<Handle>(owner: CleanupOwner, start: () => Promise<Handle>, close: (handle: Handle) => Promise<unknown>): Promise<Handle>;
export function registerOwned<Handle>(
  owner: CleanupOwner,
  start: () => Promise<Handle>,
  close: (handle: Handle) => Promise<unknown> = (handle) => (handle as Closable).close(),
): Promise<Handle> {
  let outcome: Promise<{ handle: Handle } | undefined> | undefined;
  const closeWhatStarted = async (): Promise<void> => {
    const settled = await outcome;
    if (settled !== undefined) await close(settled.handle);
  };
  if (isCleanupContext(owner) || typeof owner !== 'function') registerCleanup(owner, closeWhatStarted, REAL_PROCESS_TEST_TIMEOUT_MS);
  else owner(closeWhatStarted);
  const started = (async () => start())();
  outcome = started.then(
    (handle) => ({ handle }),
    () => undefined,
  );
  return started;
}

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
    const gone = await forceKillGroup(child.pid, { deadline: systemWaitTiming.monotonicMs() + PROCESS_KILL_DEADLINE_MS });
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
