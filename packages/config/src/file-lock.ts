import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { isProcessAlive, systemClock } from '@momonga/foundation';
import type { Clock } from '@momonga/foundation';

const GARBLED_LOCK_GRACE_MS = 2000;
const ABANDONED_TAKEOVER_MS = 10000;
const LOCK_RETRY_MS = 10;
const DEFAULT_LOCK_TIMEOUT_MS = 10000;

type LockState = { kind: 'missing' } | { kind: 'pid'; pid: number } | { kind: 'garbled'; ageMs: number };

export type FileLockPorts = {
  clock: Clock;
  sleep(ms: number): Promise<void>;
  randomHex(bytes: number): string;
};

export const systemFileLockPorts: FileLockPorts = {
  clock: systemClock,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  randomHex: (bytes) => randomBytes(bytes).toString('hex'),
};

const readLockState = async (lockPath: string, ports: FileLockPorts): Promise<LockState> => {
  let raw: string;
  let modifiedAt: number;
  try {
    raw = await fs.promises.readFile(lockPath, 'utf8');
    modifiedAt = (await fs.promises.stat(lockPath)).mtimeMs;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' };
    throw error;
  }
  const pid = Number.parseInt(raw, 10);
  if (Number.isInteger(pid) && pid > 0) return { kind: 'pid', pid };
  return { kind: 'garbled', ageMs: ports.clock.now() - modifiedAt };
};

const tryCreateLock = async (lockPath: string, ports: FileLockPorts): Promise<boolean> => {
  const temporary = `${lockPath}.${process.pid}.${ports.randomHex(6)}.tmp`;
  await fs.promises.writeFile(temporary, String(process.pid), { flag: 'wx', mode: 0o600 });
  try {
    await fs.promises.link(temporary, lockPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  } finally {
    await fs.promises.rm(temporary, { force: true });
  }
};

const sameState = (current: LockState, observed: LockState): boolean =>
  current.kind === observed.kind && (current.kind !== 'pid' || (observed.kind === 'pid' && current.pid === observed.pid));

const removeStaleLock = async (lockPath: string, observed: LockState, ports: FileLockPorts): Promise<void> => {
  const mutex = `${lockPath}.takeover`;
  try {
    await fs.promises.mkdir(mutex, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const age = await fs.promises.stat(mutex).then(
      (stat) => ports.clock.now() - stat.mtimeMs,
      (statError: NodeJS.ErrnoException) => {
        if (statError.code === 'ENOENT') return 0;
        throw statError;
      },
    );
    if (age > ABANDONED_TAKEOVER_MS) await fs.promises.rm(mutex, { recursive: true, force: true });
    else await ports.sleep(LOCK_RETRY_MS);
    return;
  }
  try {
    if (sameState(await readLockState(lockPath, ports), observed)) await fs.promises.rm(lockPath, { force: true });
  } finally {
    await fs.promises.rm(mutex, { recursive: true, force: true });
  }
};

const rejectUnsafeLockEntry = async (lockPath: string): Promise<'missing' | 'regular' | 'removed'> => {
  let stat: fs.Stats;
  try {
    stat = await fs.promises.lstat(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    throw error;
  }
  if (stat.isSymbolicLink()) {
    await fs.promises.unlink(lockPath);
    return 'removed';
  }
  if (!stat.isFile()) throw new Error(`lock path ${lockPath} is not a regular file`);
  return 'regular';
};

const acquireLock = async (lockPath: string, timeoutMs: number, ports: FileLockPorts): Promise<void> => {
  const deadline = ports.clock.now() + timeoutMs;
  let holder = 'unknown';
  for (;;) {
    if (await tryCreateLock(lockPath, ports)) return;
    if ((await rejectUnsafeLockEntry(lockPath)) !== 'regular') continue;
    const state = await readLockState(lockPath, ports);
    if (state.kind === 'missing') continue;
    if (state.kind === 'pid') holder = String(state.pid);
    const stale = state.kind === 'garbled' ? state.ageMs > GARBLED_LOCK_GRACE_MS : !isProcessAlive(state.pid);
    if (stale) {
      await removeStaleLock(lockPath, state, ports);
      continue;
    }
    if (ports.clock.now() >= deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for lock ${lockPath} held by process ${holder}`);
    await ports.sleep(LOCK_RETRY_MS);
  }
};

const releaseLock = async (lockPath: string): Promise<void> => {
  let raw: string;
  try {
    raw = await fs.promises.readFile(lockPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (Number.parseInt(raw, 10) !== process.pid) return;
  await fs.promises.rm(lockPath, { force: true });
};

export type FileLockOptions = { ports: FileLockPorts; timeoutMs?: number };

export const withFileLock = async <T>(lockPath: string, task: () => Promise<T>, options: FileLockOptions): Promise<T> => {
  await acquireLock(lockPath, options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS, options.ports);
  try {
    return await task();
  } finally {
    await releaseLock(lockPath);
  }
};
