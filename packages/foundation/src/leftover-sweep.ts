import fs from 'node:fs';
import path from 'node:path';
import type { ClaimOutcome, HeldKernelLock, KernelLockMechanism } from './platform/kernel-lock.ts';
import { claimPathOf, lockFormOf, sidecarSuffixOf } from './platform/lock-form.ts';
import type { LockForm } from './platform/lock-form.ts';

export type LeftoverFiles = {
  readdir(directory: string): Promise<string[]>;
  rm(entry: string): Promise<void>;
};

export type LeftoverDirectory = {
  readonly directory: string;
  isLeftover(name: string): boolean;
  retain?(name: string): boolean;
};

export type LeftoverSweep = { readonly removed: readonly string[]; readonly kept: readonly string[] };

export type SweepLeftoversOptions = {
  directories: readonly LeftoverDirectory[];
  lock: KernelLockMechanism;
  files?: LeftoverFiles;
  warn?(message: string): void;
};

export const nodeLeftoverFiles: LeftoverFiles = {
  readdir: (directory) => fs.promises.readdir(directory),
  rm: (entry) => fs.promises.rm(entry, { recursive: true, force: true }),
};

type Unit = { name: string; entry: boolean; sidecar: boolean };

type UnitOutcome = 'removed' | 'kept';

const codeOf = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | undefined)?.code;

const namesIn = async (files: LeftoverFiles, directory: string): Promise<string[]> => {
  try {
    return await files.readdir(directory);
  } catch (error) {
    if (codeOf(error) === 'ENOENT') return [];
    throw error;
  }
};

const unitsOf = (names: readonly string[], registered: LeftoverDirectory, sidecarSuffix: string): Unit[] => {
  const units = new Map<string, Unit>();
  const unitOf = (name: string): Unit => {
    const existing = units.get(name);
    if (existing !== undefined) return existing;
    const created = { name, entry: false, sidecar: false };
    units.set(name, created);
    return created;
  };
  for (const name of names) {
    const base = name.endsWith(sidecarSuffix) ? name.slice(0, -sidecarSuffix.length) : undefined;
    if (base !== undefined && base !== '' && registered.isLeftover(base)) unitOf(base).sidecar = true;
    else if (registered.isLeftover(name)) unitOf(name).entry = true;
  }
  return [...units.values()];
};

const formOfUnit = (lock: KernelLockMechanism, unit: Unit): LockForm | 'unproved' => {
  if (unit.sidecar) return 'sidecar';
  return lockFormOf(lock, 'file') === 'entry' ? 'entry' : 'unproved';
};

const CANNOT_CARRY_ENTRY_LOCK: readonly string[] = ['EISDIR', 'ELOOP'];

const claimUnit = async (lock: KernelLockMechanism, entry: string, form: LockForm): Promise<ClaimOutcome | { kind: 'unproved' }> => {
  try {
    return await lock.claim(claimPathOf(lock, entry, form));
  } catch (error) {
    if (form === 'entry' && CANNOT_CARRY_ENTRY_LOCK.includes(codeOf(error) ?? '')) return { kind: 'unproved' };
    throw error;
  }
};

const removeUnderClaim = async (files: LeftoverFiles, unit: Unit, entry: string, form: LockForm, held: HeldKernelLock): Promise<void> => {
  try {
    if (unit.entry) await files.rm(entry);
  } catch (error) {
    held.release();
    throw error;
  }
  if (form === 'sidecar') held.dispose();
  else held.release();
};

type EntryErrors = ((message: string) => void) | undefined;

const keptMessage = (entry: string, error: unknown): string => `leftover cleanup kept ${entry}: ${codeOf(error) ?? (error instanceof Error ? error.message : String(error))}`;

const reportedOr = async <T>(entry: string, onEntryError: EntryErrors, failed: T, work: () => Promise<T>): Promise<T> => {
  if (onEntryError === undefined) return work();
  try {
    return await work();
  } catch (error) {
    onEntryError(keptMessage(entry, error));
    return failed;
  }
};

const isRetained = (registered: LeftoverDirectory, unit: Unit, held: HeldKernelLock): boolean => {
  if (!unit.entry || registered.retain === undefined) return false;
  try {
    return registered.retain(unit.name);
  } catch (error) {
    held.release();
    throw error;
  }
};

const sweepUnit = async (registered: LeftoverDirectory, lock: KernelLockMechanism, files: LeftoverFiles, unit: Unit, onEntryError: EntryErrors): Promise<UnitOutcome> => {
  const form = formOfUnit(lock, unit);
  if (form === 'unproved') return 'kept';
  const entry = path.join(registered.directory, unit.name);
  const held = await reportedOr<HeldKernelLock | undefined>(entry, onEntryError, undefined, async () => {
    const outcome = await claimUnit(lock, entry, form);
    return outcome.kind === 'claimed' ? outcome.lock : undefined;
  });
  if (held === undefined) return 'kept';
  if (isRetained(registered, unit, held)) {
    held.release();
    return 'kept';
  }
  return reportedOr<UnitOutcome>(entry, onEntryError, 'kept', async () => {
    await removeUnderClaim(files, unit, entry, form, held);
    return 'removed';
  });
};

export const sweepLeftovers = async ({ directories, lock, files = nodeLeftoverFiles, warn: onEntryError }: SweepLeftoversOptions): Promise<LeftoverSweep> => {
  const removed: string[] = [];
  const kept: string[] = [];
  const sidecarSuffix = sidecarSuffixOf(lock);
  for (const registered of directories) {
    const names = await reportedOr<string[]>(registered.directory, onEntryError, [], () => namesIn(files, registered.directory));
    for (const unit of unitsOf(names, registered, sidecarSuffix)) {
      const outcome = await sweepUnit(registered, lock, files, unit, onEntryError);
      (outcome === 'removed' ? removed : kept).push(path.join(registered.directory, unit.name));
    }
  }
  return { removed, kept };
};
