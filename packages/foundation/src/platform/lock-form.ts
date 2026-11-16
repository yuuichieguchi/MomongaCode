import type { HeldKernelLock, KernelLockMechanism } from './kernel-lock.ts';
import { LOCK_DATABASE_SUFFIX } from './sqlite-lock.ts';

export const LEFTOVER_LOCK_FORMS = ['entry', 'sidecar'] as const;

export type LockForm = (typeof LEFTOVER_LOCK_FORMS)[number];

export type EntryKind = 'file' | 'directory';

type MechanismName = KernelLockMechanism['name'];

type MechanismForms = {
  readonly forms: Readonly<Record<EntryKind, LockForm>>;
  readonly sidecarSuffix: string;
  readonly mechanismAddsSuffix: boolean;
};

const MECHANISM_FORMS: Readonly<Record<MechanismName, MechanismForms>> = {
  'file-lock': { forms: { file: 'entry', directory: 'sidecar' }, sidecarSuffix: '.lock', mechanismAddsSuffix: false },
  'sqlite-lock': { forms: { file: 'sidecar', directory: 'sidecar' }, sidecarSuffix: LOCK_DATABASE_SUFFIX, mechanismAddsSuffix: true },
};

export const lockFormOf = (mechanism: Pick<KernelLockMechanism, 'name'>, kind: EntryKind): LockForm => MECHANISM_FORMS[mechanism.name].forms[kind];

export const sidecarSuffixOf = (mechanism: Pick<KernelLockMechanism, 'name'>): string => MECHANISM_FORMS[mechanism.name].sidecarSuffix;

const COMPANION_SUFFIXES: Readonly<Record<MechanismName, readonly string[]>> = {
  'file-lock': [],
  'sqlite-lock': ['-journal'],
};

export const sidecarNameSuffixesOf = (mechanism: Pick<KernelLockMechanism, 'name'>): { sidecar: string; companions: readonly string[] } => {
  const sidecar = sidecarSuffixOf(mechanism);
  return { sidecar, companions: COMPANION_SUFFIXES[mechanism.name].map((companion) => `${sidecar}${companion}`) };
};

export const sidecarOf = (mechanism: Pick<KernelLockMechanism, 'name'>, entry: string): string => `${entry}${sidecarSuffixOf(mechanism)}`;

export const claimPathOf = (mechanism: Pick<KernelLockMechanism, 'name'>, entry: string, form: LockForm): string =>
  form === 'entry' || MECHANISM_FORMS[mechanism.name].mechanismAddsSuffix ? entry : sidecarOf(mechanism, entry);

export class EntryLockHeldError extends Error {
  readonly entry: string;
  constructor(entry: string) {
    super(`the lock of ${entry} is held by another process, so ${entry} cannot be created under that name`);
    this.name = 'EntryLockHeldError';
    this.entry = entry;
  }
}

export class SyncClaimUnsupportedError extends Error {
  constructor(mechanism: MechanismName) {
    super(`the ${mechanism} lock mechanism given to a synchronous writer has no synchronous claim`);
    this.name = 'SyncClaimUnsupportedError';
  }
}

export const claimNewEntry = async (mechanism: KernelLockMechanism, entry: string, form: LockForm): Promise<HeldKernelLock> => {
  const outcome = await mechanism.claim(claimPathOf(mechanism, entry, form));
  if (outcome.kind === 'held') throw new EntryLockHeldError(entry);
  return outcome.lock;
};

export const claimNewEntrySync = (mechanism: KernelLockMechanism, entry: string, form: LockForm): HeldKernelLock => {
  if (mechanism.claimSync === undefined) throw new SyncClaimUnsupportedError(mechanism.name);
  const outcome = mechanism.claimSync(claimPathOf(mechanism, entry, form));
  if (outcome.kind === 'held') throw new EntryLockHeldError(entry);
  return outcome.lock;
};
