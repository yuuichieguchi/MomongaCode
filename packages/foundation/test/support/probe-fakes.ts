import fs from 'node:fs';
import type { CommandOptions, CommandResult, CommandRunner } from '../../src/platform/command-runner.ts';
import type { FileLockOps } from '../../src/platform/kernel-lock.ts';
import { nodeFileLockOps } from '../../src/platform/kernel-lock.ts';
import type { LockCapability, LockCapabilityProbe } from '../../src/platform/lock-capability.ts';

export const LOCK_FLAG_BITS = 0x10 | 0x20;

export type VirtualTiming = {
  now(): number;
  sleep(ms: number): Promise<void>;
  advanceTo(time: number): Promise<void>;
};

export const flushAsync = async (rounds = 20): Promise<void> => {
  for (let round = 0; round < rounds; round += 1) await new Promise<void>((resolve) => setImmediate(resolve));
};

export const virtualTiming = (): VirtualTiming => {
  let current = 0;
  const waiters: Array<{ at: number; wake: () => void }> = [];
  return {
    now: () => current,
    sleep: (ms) =>
      new Promise<void>((resolve) => {
        waiters.push({ at: current + ms, wake: resolve });
      }),
    advanceTo: async (time) => {
      for (;;) {
        await flushAsync();
        waiters.sort((left, right) => left.at - right.at);
        const next = waiters[0];
        if (next === undefined || next.at > time) break;
        waiters.shift();
        current = next.at;
        next.wake();
      }
      current = time;
      await flushAsync();
    },
  };
};

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

export const pendingOrSettled = async <T>(promise: Promise<T>): Promise<{ state: 'pending' } | { state: 'resolved'; value: T } | { state: 'rejected'; reason: unknown }> => {
  const outcome = promise.then(
    (value) => ({ state: 'resolved' as const, value }),
    (reason: unknown) => ({ state: 'rejected' as const, reason }),
  );
  return Promise.race([outcome, flushAsync().then(() => ({ state: 'pending' as const }))]);
};
