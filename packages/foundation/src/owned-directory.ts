import fs from 'node:fs';
import path from 'node:path';
import type { HeldKernelLock, KernelLockMechanism } from './platform/kernel-lock.ts';
import { claimNewEntry, claimNewEntrySync } from './platform/lock-form.ts';
import type { Random } from './random.ts';
import { systemRandom } from './system-random.ts';

export type OwnedDirectoryOptions = { parent: string; lock: KernelLockMechanism } & ({ prefix: string; random?: Random } | { name: string });

export type OwnedDirectory = { readonly path: string; dispose(): Promise<void> };

export type OwnedDirectorySync = { readonly path: string; dispose(): void };

const NAME_SUFFIX_BYTES = 6;
const OWNED_DIRECTORY_MODE = 0o700;

const ownedPathOf = (options: OwnedDirectoryOptions): string =>
  'name' in options ? path.join(options.parent, options.name) : path.join(options.parent, `${options.prefix}${(options.random ?? systemRandom).hex(NAME_SUFFIX_BYTES)}`);

const disposeOnce = (held: HeldKernelLock, removeDirectory: () => void): (() => void) => {
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    try {
      removeDirectory();
    } catch (error) {
      held.release();
      throw error;
    }
    held.dispose();
  };
};

export const createOwnedDirectory = async (options: OwnedDirectoryOptions): Promise<OwnedDirectory> => {
  const directory = ownedPathOf(options);
  const held = await claimNewEntry(options.lock, directory, 'sidecar');
  try {
    await fs.promises.mkdir(directory, { mode: OWNED_DIRECTORY_MODE });
  } catch (error) {
    held.dispose();
    throw error;
  }
  let disposing: Promise<void> | undefined;
  return {
    path: directory,
    dispose: () => {
      disposing ??= fs.promises.rm(directory, { recursive: true, force: true }).then(
        () => held.dispose(),
        (error: unknown) => {
          held.release();
          throw error;
        },
      );
      return disposing;
    },
  };
};

export const createOwnedDirectorySync = (options: OwnedDirectoryOptions): OwnedDirectorySync => {
  const directory = ownedPathOf(options);
  const held = claimNewEntrySync(options.lock, directory, 'sidecar');
  try {
    fs.mkdirSync(directory, { mode: OWNED_DIRECTORY_MODE });
  } catch (error) {
    held.dispose();
    throw error;
  }
  return { path: directory, dispose: disposeOnce(held, () => fs.rmSync(directory, { recursive: true, force: true })) };
};
