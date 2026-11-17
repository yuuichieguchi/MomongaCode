import type { FileSystem } from './node-file-system.ts';
import path from 'node:path';
import { nodeFileSystem } from './node-file-system.ts';
import type { ClaimOutcome, HeldKernelLock, KernelLockMechanism } from './platform/kernel-lock.ts';
import { claimPathOf, lockFormOf, sidecarNameSuffixesOf } from './platform/lock-form.ts';
import type { EntryKind, LockForm } from './platform/lock-form.ts';

export type LeftoverFiles = Pick<FileSystem, 'readdir'> & {
  rm(entry: string): Promise<void>;
  kindOf?(entry: string): Promise<EntryKind>;
};

export type LeftoverDirectory = {
  readonly directory: string;
  isLeftover(name: string): boolean;
  retain?(name: string): Promise<Retention>;
};

export type Retention = { kind: 'free' } | { kind: 'kept' } | { kind: 'reported'; reason: string };

export type LeftoverSweep = { readonly removed: readonly string[]; readonly kept: readonly string[] };

export type SweepLeftoversOptions = {
  directories: readonly LeftoverDirectory[];
  lock: KernelLockMechanism;
  files?: LeftoverFiles;
  warn?(message: string): void;
};

const kindOfEntry = async (entry: string): Promise<EntryKind> => ((await nodeFileSystem.lstat(entry)).isDirectory() ? 'directory' : 'file');

export const nodeLeftoverFiles: LeftoverFiles = {
  readdir: (directory) => nodeFileSystem.readdir(directory),
  rm: (entry) => nodeFileSystem.rm(entry, { recursive: true }),
  kindOf: kindOfEntry,
};

type Unit = { name: string; entry: boolean; sidecar: boolean; companions: string[] };

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

const unitsOf = (names: readonly string[], registered: LeftoverDirectory, suffixes: { sidecar: string; companions: readonly string[] }): Unit[] => {
  const units = new Map<string, Unit>();
  const unitOf = (name: string): Unit => {
    const existing = units.get(name);
    if (existing !== undefined) return existing;
    const created: Unit = { name, entry: false, sidecar: false, companions: [] };
    units.set(name, created);
    return created;
  };
  const sidecarOwnerOf = (name: string): { base: string; companion: boolean } | undefined => {
    for (const companion of suffixes.companions) {
      if (name.endsWith(companion) && name.length > companion.length) return { base: name.slice(0, -companion.length), companion: true };
    }
    if (name.endsWith(suffixes.sidecar) && name.length > suffixes.sidecar.length) return { base: name.slice(0, -suffixes.sidecar.length), companion: false };
    return undefined;
  };
  for (const name of names) {
    const owner = sidecarOwnerOf(name);
    if (owner !== undefined && registered.isLeftover(owner.base)) {
      const unit = unitOf(owner.base);
      unit.sidecar = true;
      if (owner.companion) unit.companions.push(name);
    } else if (registered.isLeftover(name)) unitOf(name).entry = true;
  }
  return [...units.values()];
};

const formOfEntry = async (lock: KernelLockMechanism, entry: string, files: LeftoverFiles): Promise<LockForm | undefined> => {
  try {
    return lockFormOf(lock, await (files.kindOf ?? kindOfEntry)(entry));
  } catch (error) {
    if (codeOf(error) === 'ENOENT') return undefined;
    throw error;
  }
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
    for (const companion of unit.companions) await files.rm(path.join(path.dirname(entry), companion));
  } catch (error) {
    held.release();
    throw error;
  }
  if (form === 'sidecar') held.dispose();
  else held.release();
};

type EntryErrors = ((message: string) => void) | undefined;

const keptText = (entry: string, reason: string): string => `leftover cleanup kept ${entry}: ${reason}`;

const keptMessage = (entry: string, error: unknown): string => keptText(entry, codeOf(error) ?? (error instanceof Error ? error.message : String(error)));

const reportedOr = async <T>(entry: string, onEntryError: EntryErrors, failed: T, work: () => Promise<T>): Promise<T> => {
  if (onEntryError === undefined) return work();
  try {
    return await work();
  } catch (error) {
    onEntryError(keptMessage(entry, error));
    return failed;
  }
};

const retentionOf = async (registered: LeftoverDirectory, unit: Unit, held: HeldKernelLock): Promise<Retention> => {
  if (!unit.entry || registered.retain === undefined) return { kind: 'free' };
  try {
    return await registered.retain(unit.name);
  } catch (error) {
    held.release();
    throw error;
  }
};

const sweepUnit = async (registered: LeftoverDirectory, lock: KernelLockMechanism, files: LeftoverFiles, unit: Unit, onEntryError: EntryErrors): Promise<UnitOutcome> => {
  const entry = path.join(registered.directory, unit.name);
  const form = unit.sidecar ? 'sidecar' : await reportedOr<LockForm | undefined>(entry, onEntryError, undefined, () => formOfEntry(lock, entry, files));
  if (form === undefined) return 'kept';
  const held = await reportedOr<HeldKernelLock | undefined>(entry, onEntryError, undefined, async () => {
    const outcome = await claimUnit(lock, entry, form);
    return outcome.kind === 'claimed' ? outcome.lock : undefined;
  });
  if (held === undefined) return 'kept';
  const retention = await retentionOf(registered, unit, held);
  if (retention.kind !== 'free') {
    held.release();
    if (retention.kind === 'reported') onEntryError?.(keptText(entry, retention.reason));
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
  const suffixes = sidecarNameSuffixesOf(lock);
  for (const registered of directories) {
    const names = await reportedOr<string[]>(registered.directory, onEntryError, [], () => namesIn(files, registered.directory));
    for (const unit of unitsOf(names, registered, suffixes)) {
      const outcome = await sweepUnit(registered, lock, files, unit, onEntryError);
      (outcome === 'removed' ? removed : kept).push(path.join(registered.directory, unit.name));
    }
  }
  return { removed, kept };
};
