import { spawn } from 'node:child_process';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { TestContext } from 'vitest';
import { SOCKET_PATH_LIMIT, forceKillGroup, isProcessAlive, momongaLayout } from '@momonga/foundation';
import { stopSupervisorHolder } from './process-groups.ts';

export const TEST_RUN_ENV = 'MOMONGA_TEST_RUN';
export const TEMP_DIR_PREFIX = 'mmt-';
export const TEST_HEARTBEAT_MS = 10_000;
export const REAL_PROCESS_TEST_TIMEOUT_MS = 30_000;
export const DAEMON_PROCESS_TEST_TIMEOUT_MS = 2 * REAL_PROCESS_TEST_TIMEOUT_MS;
export const BUILT_BINARY_TEST_TIMEOUT_MS = 3 * REAL_PROCESS_TEST_TIMEOUT_MS;

const PROCESS_KILL_DEADLINE_MS = 5000;

export const testRunToken = (): string => process.env[TEST_RUN_ENV] ?? 'x';

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

export const registerCleanup = (context: CleanupContext | undefined, cleanup: Cleanup): void => {
  assertTestContext(context, 'registerCleanup');
  context.onTestFinished(cleanup);
};

const longestSocketOf = (home: string): string => {
  const sockets = Object.values(momongaLayout(home, 'darwin', {}).sockets);
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

const removeTempDir = (dir: string): void => {
  restoreWritable(dir);
  fs.rmSync(dir, { recursive: true, force: true });
  if (fs.existsSync(dir)) throw new Error(`test temp dir ${dir} still exists after cleanup`);
};

export type TempDirOptions = { asHome?: boolean };

export const withTempDir = (context: CleanupContext | undefined, options: TempDirOptions = {}): string => {
  assertTestContext(context, 'withTempDir');
  const created = fs.mkdtempSync(path.join(os.tmpdir(), tempDirPrefixFor(testRunToken())));
  const asHome = options.asHome === true;
  context.onTestFinished(async () => {
    if (asHome) await stopSupervisorHolder(created);
    removeTempDir(created);
  });
  const dir = fs.realpathSync(created);
  fs.chmodSync(dir, 0o700);
  if (asHome) assertHomeSocketBudget(dir);
  return dir;
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
