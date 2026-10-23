import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { isProcessAlive } from './process-alive.ts';

export type DescribeHolder = (pid: number) => Promise<string>;

export interface ProcessLock {
  release(): void;
}

export class ProcessLockHeldError extends Error {
  readonly lockPath: string;
  readonly holderPid: number;

  constructor(message: string, lockPath: string, holderPid: number) {
    super(message);
    this.name = 'ProcessLockHeldError';
    this.lockPath = lockPath;
    this.holderPid = holderPid;
  }
}

const GARBLED_LOCK_GRACE_MS = 2000;
const ABANDONED_TAKEOVER_MS = 10000;
const LOCK_RETRY_MS = 25;

type LockState =
  | { kind: 'missing' }
  | { kind: 'pid'; pid: number }
  | { kind: 'garbled'; ageMs: number };

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

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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

const acquireLock = async (lockPath: string, describeHolder: DescribeHolder): Promise<void> => {
  for (;;) {
    if (await tryCreateLock(lockPath)) return;
    const state = await readLockState(lockPath);
    if (state.kind === 'missing') continue;
    if (state.kind === 'garbled') {
      if (state.ageMs > GARBLED_LOCK_GRACE_MS) await removeStaleLock(lockPath, state);
      else await pause(LOCK_RETRY_MS);
      continue;
    }
    if (!isProcessAlive(state.pid)) {
      await removeStaleLock(lockPath, state);
      continue;
    }
    throw new ProcessLockHeldError(await describeHolder(state.pid), lockPath, state.pid);
  }
};

const releaseLock = (lockPath: string): void => {
  let raw: string;
  try {
    raw = fs.readFileSync(lockPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (Number.parseInt(raw, 10) !== process.pid) return;
  fs.rmSync(lockPath, { force: true });
};

export const acquireProcessLock = async (
  lockPath: string,
  describeHolder: DescribeHolder = async (pid) => `${lockPath} is held by live process ${pid}; remove it if that process is not momonga`,
): Promise<ProcessLock> => {
  await acquireLock(lockPath, describeHolder);
  return { release: () => releaseLock(lockPath) };
};
