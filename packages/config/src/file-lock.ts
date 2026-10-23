import { randomBytes } from 'node:crypto';
import fs from 'node:fs';

const GARBLED_LOCK_GRACE_MS = 2000;
const ABANDONED_TAKEOVER_MS = 10000;
const LOCK_RETRY_MS = 10;
const DEFAULT_LOCK_TIMEOUT_MS = 10000;

type LockState = { kind: 'missing' } | { kind: 'pid'; pid: number } | { kind: 'garbled'; ageMs: number };

const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return true;
    throw error;
  }
};

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const readLockState = async (lockPath: string): Promise<LockState> => {
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
  return { kind: 'garbled', ageMs: Date.now() - modifiedAt };
};

const tryCreateLock = async (lockPath: string): Promise<boolean> => {
  const temporary = `${lockPath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
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

const removeStaleLock = async (lockPath: string, observed: LockState): Promise<void> => {
  const mutex = `${lockPath}.takeover`;
  try {
    await fs.promises.mkdir(mutex, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const age = await fs.promises.stat(mutex).then(
      (stat) => Date.now() - stat.mtimeMs,
      (statError: NodeJS.ErrnoException) => {
        if (statError.code === 'ENOENT') return 0;
        throw statError;
      },
    );
    if (age > ABANDONED_TAKEOVER_MS) await fs.promises.rm(mutex, { recursive: true, force: true });
    else await pause(LOCK_RETRY_MS);
    return;
  }
  try {
    if (sameState(await readLockState(lockPath), observed)) await fs.promises.rm(lockPath, { force: true });
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

const acquireLock = async (lockPath: string, timeoutMs: number): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  let holder = 'unknown';
  for (;;) {
    if (await tryCreateLock(lockPath)) return;
    if ((await rejectUnsafeLockEntry(lockPath)) !== 'regular') continue;
    const state = await readLockState(lockPath);
    if (state.kind === 'missing') continue;
    if (state.kind === 'pid') holder = String(state.pid);
    const stale = state.kind === 'garbled' ? state.ageMs > GARBLED_LOCK_GRACE_MS : !isProcessAlive(state.pid);
    if (stale) {
      await removeStaleLock(lockPath, state);
      continue;
    }
    if (Date.now() >= deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for lock ${lockPath} held by process ${holder}`);
    await pause(LOCK_RETRY_MS);
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

export type FileLockOptions = { timeoutMs?: number };

export const withFileLock = async <T>(lockPath: string, task: () => Promise<T>, options: FileLockOptions = {}): Promise<T> => {
  await acquireLock(lockPath, options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS);
  try {
    return await task();
  } finally {
    await releaseLock(lockPath);
  }
};
