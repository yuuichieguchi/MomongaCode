import { claimNewEntry } from './lock-form.ts';
import type { HeldKernelLock, KernelLockMechanism } from './kernel-lock.ts';

export type ExecutableRename = (from: string, to: string) => Promise<void>;

export class ExecutableInUseError extends Error {
  readonly code: string;
  constructor(target: string, code: string, options: { cause: unknown }) {
    super(`${target} is in use and could not be moved aside (${code}): stop the daemon, then run the command again`, options);
    this.name = 'ExecutableInUseError';
    this.code = code;
  }
}

const REPLACE_REFUSED_CODES: ReadonlySet<string> = new Set(['EPERM', 'EACCES', 'EBUSY']);

const errorCodeOf = (error: unknown): string | undefined => {
  const code: unknown = typeof error === 'object' && error !== null ? Object.getOwnPropertyDescriptor(error, 'code')?.value : undefined;
  return typeof code === 'string' ? code : undefined;
};

const asidesHeldWhileThisProcessRuns: HeldKernelLock[] = [];

export const replaceExecutable = async (rename: ExecutableRename, lock: KernelLockMechanism, staged: string, target: string, aside: string): Promise<void> => {
  try {
    await rename(staged, target);
    return;
  } catch (error) {
    const code = errorCodeOf(error);
    if (code === undefined || !REPLACE_REFUSED_CODES.has(code)) throw error;
  }
  const held = await claimNewEntry(lock, aside, 'sidecar');
  try {
    await rename(target, aside);
  } catch (refused) {
    held.dispose();
    const code = errorCodeOf(refused);
    if (code !== undefined && REPLACE_REFUSED_CODES.has(code)) throw new ExecutableInUseError(target, code, { cause: refused });
    throw refused;
  }
  try {
    await rename(staged, target);
  } catch (second) {
    await rename(aside, target);
    held.dispose();
    throw second;
  }
  asidesHeldWhileThisProcessRuns.push(held);
};
