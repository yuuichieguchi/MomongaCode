import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { LOCK_FD } from './process-contract.ts';
import { hostKernelLock } from './platform/kernel-lock.ts';
import type { HeldKernelLock, KernelLockMechanism } from './platform/kernel-lock.ts';
import { noFollowFlag } from './platform/privacy.ts';

export type DescribeHolder = (pid: number | undefined) => Promise<string>;

export interface ProcessLock {
  release(): void;
}

export class ProcessLockHeldError extends Error {
  readonly lockPath: string;
  readonly holderPid: number | undefined;

  constructor(message: string, lockPath: string, holderPid: number | undefined) {
    super(message);
    this.name = 'ProcessLockHeldError';
    this.lockPath = lockPath;
    this.holderPid = holderPid;
  }
}

export class LockAdoptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LockAdoptionError';
  }
}

export const LOCK_FD_ENV = 'MOMONGA_LOCK_FD';
export const LOCK_NONCE_ENV = 'MOMONGA_LOCK_NONCE';
export const HOLDER_READ_MAX_BYTES = 64;
const NONCE_BYTES = 16;
const HANDOFF_PREFIX = 'handoff:';

export type ProcessLockOptions = { mechanism?: KernelLockMechanism };

export type InspectProcessLockOptions = ProcessLockOptions;

export type AcquireProcessLockOptions = ProcessLockOptions;

export type ProcessLockInspection = { state: 'free' } | { state: 'held'; pid: number } | { state: 'unreadable' };

type RecordedHolder = { kind: 'pid'; pid: number } | { kind: 'unrecorded' };

const readHolder = async (lockPath: string): Promise<RecordedHolder> => {
  let handle: fs.promises.FileHandle;
  try {
    handle = await fs.promises.open(lockPath, fs.constants.O_RDONLY | noFollowFlag());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'unrecorded' };
    throw error;
  }
  let text: string;
  try {
    const buffer = Buffer.alloc(HOLDER_READ_MAX_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, HOLDER_READ_MAX_BYTES, 0);
    text = buffer.toString('utf8', 0, bytesRead);
  } finally {
    await handle.close();
  }
  return holderOf(text);
};

const holderOf = (text: string): RecordedHolder => (/^[1-9]\d{0,9}$/.test(text) ? { kind: 'pid', pid: Number(text) } : { kind: 'unrecorded' });

const readHolderSync = (lockPath: string): RecordedHolder => {
  let descriptor: number;
  try {
    descriptor = fs.openSync(lockPath, fs.constants.O_RDONLY | noFollowFlag());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'unrecorded' };
    throw error;
  }
  try {
    const buffer = Buffer.alloc(HOLDER_READ_MAX_BYTES);
    const bytesRead = fs.readSync(descriptor, buffer, 0, HOLDER_READ_MAX_BYTES, 0);
    return holderOf(buffer.toString('utf8', 0, bytesRead));
  } finally {
    fs.closeSync(descriptor);
  }
};

export const inspectProcessLock = async (lockPath: string, options: InspectProcessLockOptions = {}): Promise<ProcessLockInspection> => {
  const mechanism = options.mechanism ?? hostKernelLock();
  if (!(await mechanism.isHeld(lockPath))) return { state: 'free' };
  const holder = await readHolder(lockPath);
  return holder.kind === 'pid' ? { state: 'held', pid: holder.pid } : { state: 'unreadable' };
};

const lockOf = (held: HeldKernelLock): ProcessLock => ({ release: () => held.release() });

const claimed = (held: HeldKernelLock): ProcessLock => {
  held.writeHolder(String(process.pid));
  return lockOf(held);
};

export const acquireProcessLock = async (
  lockPath: string,
  describeHolder: DescribeHolder = async (pid) => `${lockPath} is held by ${pid === undefined ? 'another process' : `live process ${pid}`}`,
  options: AcquireProcessLockOptions = {},
): Promise<ProcessLock> => {
  const mechanism = options.mechanism ?? hostKernelLock();
  const outcome = await mechanism.claim(lockPath);
  if (outcome.kind === 'claimed') return claimed(outcome.lock);
  const holder = await readHolder(lockPath);
  const holderPid = holder.kind === 'pid' ? holder.pid : undefined;
  throw new ProcessLockHeldError(await describeHolder(holderPid), lockPath, holderPid);
};

export type LockHandoff = {
  readonly descriptor: number;
  readonly slot: number;
  readonly env: Readonly<Record<typeof LOCK_FD_ENV | typeof LOCK_NONCE_ENV, string>>;
  closeParentCopy(): void;
};

export type LockHandoffClaim = { kind: 'unsupported' } | { kind: 'held'; holderPid: number | undefined } | { kind: 'claimed'; handoff: LockHandoff };

export const claimLockForChild = (lockPath: string, options: ProcessLockOptions = {}): LockHandoffClaim => {
  const mechanism = options.mechanism ?? hostKernelLock();
  if (mechanism.claimInheritable === undefined) return { kind: 'unsupported' };
  const outcome = mechanism.claimInheritable(lockPath);
  if (outcome.kind === 'held') {
    const holder = readHolderSync(lockPath);
    return { kind: 'held', holderPid: holder.kind === 'pid' ? holder.pid : undefined };
  }
  const { lock } = outcome;
  if (lock.descriptor === undefined) throw new Error(`${mechanism.name} claimed ${lockPath} without an inheritable descriptor`);
  const nonce = randomBytes(NONCE_BYTES).toString('hex');
  try {
    lock.writeHolder(`${HANDOFF_PREFIX}${nonce}`);
  } catch (error) {
    lock.release();
    throw error;
  }
  return {
    kind: 'claimed',
    handoff: {
      descriptor: lock.descriptor,
      slot: LOCK_FD,
      env: { [LOCK_FD_ENV]: String(LOCK_FD), [LOCK_NONCE_ENV]: nonce },
      closeParentCopy: () => lock.release(),
    },
  };
};

export class UnadoptedEnv {
  readonly #env: Readonly<Record<string, string | undefined>>;

  constructor(env: Readonly<Record<string, string | undefined>>) {
    this.#env = env;
  }

  get handedOff(): boolean {
    return this.#env[LOCK_FD_ENV] !== undefined || this.#env[LOCK_NONCE_ENV] !== undefined;
  }

  withoutLockVariables(): Readonly<Record<string, string | undefined>> {
    const { [LOCK_FD_ENV]: _fd, [LOCK_NONCE_ENV]: _nonce, ...rest } = this.#env;
    return rest;
  }

  adopt(lockPath: string): ProcessLock {
    const fdText = this.#env[LOCK_FD_ENV];
    const nonce = this.#env[LOCK_NONCE_ENV];
    if (fdText === undefined || nonce === undefined) throw new LockAdoptionError(`${LOCK_FD_ENV} and ${LOCK_NONCE_ENV} must be set together`);
    if (!/^[1-9]\d{0,5}$/.test(fdText)) throw new LockAdoptionError(`${LOCK_FD_ENV} is not a descriptor number: ${JSON.stringify(fdText)}`);
    const descriptor = Number(fdText);
    let inherited: fs.BigIntStats;
    try {
      inherited = fs.fstatSync(descriptor, { bigint: true });
    } catch (error) {
      throw new LockAdoptionError(`descriptor ${descriptor} named by ${LOCK_FD_ENV} is not open: ${(error as Error).message}`);
    }
    const named = fs.statSync(lockPath, { bigint: true });
    if (!inherited.isFile() || inherited.dev !== named.dev || inherited.ino !== named.ino) {
      throw new LockAdoptionError(`descriptor ${descriptor} named by ${LOCK_FD_ENV} is not ${lockPath}`);
    }
    const buffer = Buffer.alloc(HOLDER_READ_MAX_BYTES);
    const bytesRead = fs.readSync(descriptor, buffer, 0, HOLDER_READ_MAX_BYTES, 0);
    if (buffer.toString('utf8', 0, bytesRead) !== `${HANDOFF_PREFIX}${nonce}`) {
      throw new LockAdoptionError(`${lockPath} does not carry the hand-off nonce ${LOCK_NONCE_ENV} names`);
    }
    fs.ftruncateSync(descriptor, 0);
    fs.writeSync(descriptor, String(process.pid), 0);
    let open = true;
    return {
      release: () => {
        if (!open) return;
        open = false;
        fs.closeSync(descriptor);
      },
    };
  }
}
