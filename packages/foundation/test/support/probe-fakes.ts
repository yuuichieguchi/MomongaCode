import fs from 'node:fs';
import type { CommandOptions, CommandResult, CommandRunner } from '../../src/platform/command-runner.ts';
import type { FileLockOps } from '../../src/platform/kernel-lock.ts';
import { nodeFileLockOps } from '../../src/platform/kernel-lock.ts';
import type { LockCapability, LockCapabilityProbe } from '../../src/platform/lock-capability.ts';
import { createFakeClock, createFakeTimers, driveFakeTime } from '@momonga/testkit';
import type { FakeTimers } from '@momonga/testkit';

export const LOCK_FLAG_BITS = 0x10 | 0x20;

export type VirtualTiming = FakeTimers;

export const virtualTiming = (): VirtualTiming => createFakeTimers(createFakeClock(0));

export type RecordedCommand = { file: string; args: readonly string[]; options: CommandOptions; killed: boolean };

export const killedByTimeout = (): Error => Object.assign(new Error('Command failed'), { killed: true, signal: 'SIGKILL' });

export const abortedCommand = (): Error => Object.assign(new Error('The operation was aborted'), { name: 'AbortError', code: 'ABORT_ERR' });

export const slowRunner = (latencyMs: number, answer: CommandResult, calls: RecordedCommand[] = []): CommandRunner => async (file, args, options) => {
  const call: RecordedCommand = { file, args, options, killed: false };
  calls.push(call);
  if (options.timeoutMs !== undefined && options.timeoutMs < latencyMs) {
    call.killed = true;
    throw killedByTimeout();
  }
  if (options.signal?.aborted === true) {
    call.killed = true;
    throw abortedCommand();
  }
  return answer;
};

export const silentRunner = (calls: RecordedCommand[] = []): CommandRunner => (file, args, options) =>
  new Promise<CommandResult>((_resolve, reject) => {
    const call: RecordedCommand = { file, args, options, killed: false };
    calls.push(call);
    const kill = (): void => {
      call.killed = true;
      reject(abortedCommand());
    };
    if (options.signal?.aborted === true) kill();
    else options.signal?.addEventListener('abort', kill, { once: true });
  });

export const throwingRunner = (): CommandRunner => async (file) => {
  throw new Error(`no subprocess may run, but ${file} was started`);
};

export const fixedCapability = (answer: LockCapability): LockCapabilityProbe => ({
  of: async () => answer,
  decide: () => (answer === 'unmeasured' ? 'unprovable' : answer),
  contradicted: () => undefined,
});

export const lockIgnoringOps = (base: FileLockOps = nodeFileLockOps): FileLockOps => ({
  ...base,
  open: (lockPath, flags, mode) => base.open(lockPath, flags & ~LOCK_FLAG_BITS, mode),
});

export const lockRejectingOps = (code: string, base: FileLockOps = nodeFileLockOps): FileLockOps => ({
  ...base,
  open: (lockPath, flags, mode) => {
    if ((flags & LOCK_FLAG_BITS) !== 0) throw Object.assign(new Error(`${code}: injected`), { code });
    return base.open(lockPath, flags, mode);
  },
});

export const countingOps = (base: FileLockOps = nodeFileLockOps) => {
  const opened: Array<{ path: string; flags: number }> = [];
  const ops: FileLockOps = {
    ...base,
    open: (lockPath, flags, mode) => {
      opened.push({ path: lockPath, flags });
      return base.open(lockPath, flags, mode);
    },
  };
  return { ops, opened };
};

export const switchableOps = (initial: FileLockOps) => {
  let current = initial;
  const ops: FileLockOps = {
    open: (lockPath, flags, mode) => current.open(lockPath, flags, mode),
    close: (descriptor) => current.close(descriptor),
    fstat: (descriptor) => current.fstat(descriptor),
    lstat: (lockPath) => current.lstat(lockPath),
  };
  return { ops, use: (next: FileLockOps): void => void (current = next) };
};

export const SHARED_PROBE = fs.constants.O_RDONLY | 0x10 | fs.constants.O_NONBLOCK;

export const EXCLUSIVE_PROBE = fs.constants.O_RDONLY | 0x20 | fs.constants.O_NONBLOCK;

export const sharedProbeIsRefused = (file: string): boolean => {
  try {
    fs.closeSync(fs.openSync(file, SHARED_PROBE));
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EAGAIN') return true;
    throw error;
  }
};

export const exclusiveProbeIsRefused = (file: string): boolean => {
  try {
    fs.closeSync(fs.openSync(file, EXCLUSIVE_PROBE));
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EAGAIN') return true;
    throw error;
  }
};

export type Settled<T> = { state: 'pending' } | { state: 'resolved'; value: T } | { state: 'rejected'; reason: unknown };

export type Settlement<T> = { current(): Settled<T> };

export const settlementOf = <T>(promise: Promise<T>): Settlement<T> => {
  let current: Settled<T> = { state: 'pending' };
  promise.then(
    (value) => void (current = { state: 'resolved', value }),
    (reason: unknown) => void (current = { state: 'rejected', reason }),
  );
  return { current: () => current };
};

export const driveUntil = (timing: VirtualTiming, done: () => boolean, horizonAt: number, description: string): Promise<void> => driveFakeTime(timing, { done, horizonAt, description });

export const driveUntilSettled = <T>(timing: VirtualTiming, settlement: Settlement<T>, horizonAt: number): Promise<void> =>
  driveUntil(timing, () => settlement.current().state !== 'pending', horizonAt, 'the settlement of the promise');

export type ProbeSighting = 'absent' | 'held' | 'unlocked';

export const twoStepCreateLockOps = (probeBetweenCreateAndLock: (ops: FileLockOps) => void) => {
  const exclusive = new Map<bigint, number>();
  const shared = new Map<bigint, Set<number>>();
  const inodeOf = (descriptor: number): bigint => fs.fstatSync(descriptor, { bigint: true }).ino;
  const sharersOf = (inode: bigint): Set<number> => {
    const existing = shared.get(inode);
    if (existing !== undefined) return existing;
    const fresh = new Set<number>();
    shared.set(inode, fresh);
    return fresh;
  };
  const refuse = (descriptor: number): never => {
    fs.closeSync(descriptor);
    throw Object.assign(new Error('EAGAIN: resource temporarily unavailable, open'), { code: 'EAGAIN' });
  };
  const ops: FileLockOps = {
    ...nodeFileLockOps,
    open: (lockPath, flags, mode) => {
      const descriptor = fs.openSync(lockPath, flags & ~LOCK_FLAG_BITS, mode);
      if ((flags & fs.constants.O_CREAT) !== 0 && (flags & 0x20) !== 0) probeBetweenCreateAndLock(ops);
      const inode = inodeOf(descriptor);
      if ((flags & 0x20) !== 0) {
        if (exclusive.has(inode) || sharersOf(inode).size > 0) refuse(descriptor);
        exclusive.set(inode, descriptor);
      }
      if ((flags & 0x10) !== 0) {
        if (exclusive.has(inode)) refuse(descriptor);
        sharersOf(inode).add(descriptor);
      }
      return descriptor;
    },
    close: (descriptor) => {
      for (const [inode, holder] of exclusive) if (holder === descriptor) exclusive.delete(inode);
      for (const sharers of shared.values()) sharers.delete(descriptor);
      fs.closeSync(descriptor);
    },
  };
  return ops;
};

export const stalledSharedProbe = (ops: FileLockOps, file: string): ProbeSighting => {
  try {
    ops.open(file, SHARED_PROBE);
    return 'unlocked';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return 'absent';
    if (code === 'EAGAIN') return 'held';
    throw error;
  }
};
