import path from 'node:path';
import { isRecord, systemRandom, writeFileAtomically } from '@momonga/foundation';
import type { FileSystem } from '@momonga/foundation';

type ActivePointer = Record<string, string>;

const FILE_MODE = 0o600;

const readPointer = async (fileSystem: FileSystem, file: string): Promise<ActivePointer> => {
  let text: string;
  try {
    text = await fileSystem.readTextFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed)) throw new Error(`the active plan account file ${file} is not a JSON object`);
  const pointer: ActivePointer = {};
  for (const [profile, account] of Object.entries(parsed)) {
    if (typeof account !== 'string') throw new Error(`the active plan account file ${file} names a non-string account for ${JSON.stringify(profile)}`);
    pointer[profile] = account;
  }
  return pointer;
};

export const readActiveAccount = async (fileSystem: FileSystem, file: string, profile: string): Promise<string | undefined> => {
  const pointer = await readPointer(fileSystem, file);
  return Object.hasOwn(pointer, profile) ? pointer[profile] : undefined;
};

export const writeActiveAccount = async (fileSystem: FileSystem, file: string, profile: string, account: string): Promise<void> => {
  const pointer = await readPointer(fileSystem, file);
  await fileSystem.mkdirPrivate(path.dirname(file));
  await writeFileAtomically(fileSystem, systemRandom, file, JSON.stringify({ ...pointer, [profile]: account }), { mode: FILE_MODE });
};
