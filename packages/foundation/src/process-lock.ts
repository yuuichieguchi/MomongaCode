import { randomBytes } from 'node:crypto';
import { LOCK_FD } from './process-contract.ts';
import { hostKernelLock } from './platform/host-kernel-lock.ts';
import { HOLDER_READ_MAX_BYTES, LockAdoptionError, writeHolderOrRelease } from './platform/kernel-lock.ts';
import type { HeldKernelLock, KernelLockMechanism } from './platform/kernel-lock.ts';

export { HOLDER_READ_MAX_BYTES, LockAdoptionError };

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

export const LOCK_FD_ENV = 'MOMONGA_LOCK_FD';
export const LOCK_NONCE_ENV = 'MOMONGA_LOCK_NONCE';
const NONCE_BYTES = 16;
const HANDOFF_PREFIX = 'handoff:';

export type ProcessLockOptions = { mechanism?: KernelLockMechanism; randomNonce?: () => string };

const randomHandoffNonce = (): string => randomBytes(NONCE_BYTES).toString('hex');

export type InspectProcessLockOptions = ProcessLockOptions;

export type AcquireProcessLockOptions = ProcessLockOptions;

export type ProcessLockInspection = { state: 'free' } | { state: 'held'; pid: number } | { state: 'unreadable' };

type RecordedHolder = { kind: 'pid'; pid: number } | { kind: 'unrecorded' };

const holderOf = (text: string | undefined): RecordedHolder =>
  text !== undefined && /^[1-9]\d{0,9}$/.test(text) ? { kind: 'pid', pid: Number(text) } : { kind: 'unrecorded' };

export const inspectProcessLock = async (lockPath: string, options: InspectProcessLockOptions = {}): Promise<ProcessLockInspection> => {
  const mechanism = options.mechanism ?? hostKernelLock();
  if (!(await mechanism.isHeld(lockPath))) return { state: 'free' };
  const holder = holderOf(await mechanism.readHolder(lockPath));
  return holder.kind === 'pid' ? { state: 'held', pid: holder.pid } : { state: 'unreadable' };
};

const lockOf = (held: HeldKernelLock): ProcessLock => ({ release: () => held.release() });

const claimed = (held: HeldKernelLock): ProcessLock => {
  writeHolderOrRelease(held, String(process.pid));
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
  const holder = holderOf(await mechanism.readHolder(lockPath));
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
    const holder = holderOf(mechanism.readHolderSync(lockPath));
    return { kind: 'held', holderPid: holder.kind === 'pid' ? holder.pid : undefined };
  }
  const { lock } = outcome;
  if (lock.descriptor === undefined) throw new Error(`${mechanism.name} claimed ${lockPath} without an inheritable descriptor`);
  const nonce = (options.randomNonce ?? randomHandoffNonce)();
  writeHolderOrRelease(lock, `${HANDOFF_PREFIX}${nonce}`);
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

  adopt(lockPath: string, options: ProcessLockOptions = {}): ProcessLock {
    const fdText = this.#env[LOCK_FD_ENV];
    const nonce = this.#env[LOCK_NONCE_ENV];
    if (fdText === undefined || nonce === undefined) throw new LockAdoptionError(`${LOCK_FD_ENV} and ${LOCK_NONCE_ENV} must be set together`);
    if (!/^[1-9]\d{0,5}$/.test(fdText)) throw new LockAdoptionError(`${LOCK_FD_ENV} is not a descriptor number: ${JSON.stringify(fdText)}`);
    const mechanism = options.mechanism ?? hostKernelLock();
    if (mechanism.adoptInherited === undefined) throw new LockAdoptionError(`${mechanism.name} locks cannot be handed to a child process`);
    return lockOf(mechanism.adoptInherited({ lockPath, descriptor: Number(fdText), expectedHolder: `${HANDOFF_PREFIX}${nonce}`, newHolder: String(process.pid) }));
  }
}
