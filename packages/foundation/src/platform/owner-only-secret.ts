import path from 'node:path';
import { writeFileAtomically } from '../atomic-file.ts';
import type { FileSystem } from '../node-file-system.ts';
import type { Random } from '../random.ts';
import type { KernelLockMechanism } from './kernel-lock.ts';
import { PRIVATE_MODE } from './privacy.ts';

export const OWNER_ONLY_SECRET_BYTES = 16;

const SECRET_TEXT = new RegExp(`^[0-9a-f]{${OWNER_ONLY_SECRET_BYTES * 2}}$`);

export type OwnerOnlySecretPorts = { readonly files: FileSystem; readonly random: Random; readonly lock: KernelLockMechanism };

const readSecret = async (files: FileSystem, file: string): Promise<string | undefined> => {
  const text = await files.readOwnerOnlyTextFile(file, `The secret file ${file}`, OWNER_ONLY_SECRET_BYTES * 2);
  if (text === undefined) return undefined;
  if (!SECRET_TEXT.test(text)) throw new Error(`${file} does not hold a 128-bit value`);
  return text;
};

export const ownerOnlySecret = async ({ files, random, lock }: OwnerOnlySecretPorts, directory: string, name: string): Promise<string> => {
  const file = path.join(directory, name);
  const existing = await readSecret(files, file);
  if (existing !== undefined) return existing;
  const created = random.hex(OWNER_ONLY_SECRET_BYTES);
  if ((await writeFileAtomically(files, random, file, created, { mode: PRIVATE_MODE.file, publish: 'create', lock })).created) return created;
  const winner = await readSecret(files, file);
  if (winner === undefined) throw new Error(`${file} disappeared while it was being created`);
  return winner;
};
