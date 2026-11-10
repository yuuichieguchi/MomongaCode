import path from 'node:path';
import { isRecord, systemRandom, writeFileAtomically } from '@momonga/foundation';
import type { FileSystem } from '@momonga/foundation';

export type ActivePointer = Record<string, string>;

const FILE_MODE = 0o600;

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const parsedPointer = (file: string, text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`the active plan account file ${file} is not valid JSON: ${messageOf(error)}`);
  }
};

export const readActivePointer = async (fileSystem: FileSystem, file: string): Promise<ActivePointer> => {
  let text: string;
  try {
    text = await fileSystem.readTextFile(file);
  } catch (error) {
    if (isRecord(error) && error['code'] === 'ENOENT') return {};
    throw new Error(`could not read the active plan account file ${file}: ${messageOf(error)}`);
  }
  const parsed = parsedPointer(file, text);
  if (!isRecord(parsed)) throw new Error(`the active plan account file ${file} is not a JSON object`);
  const pointer: ActivePointer = {};
  for (const [profile, account] of Object.entries(parsed)) {
    if (typeof account !== 'string') throw new Error(`the active plan account file ${file} names a non-string account for ${JSON.stringify(profile)}`);
    pointer[profile] = account;
  }
  return pointer;
};

export const writeActivePointer = async (fileSystem: FileSystem, file: string, pointer: ActivePointer): Promise<void> => {
  await fileSystem.mkdirPrivate(path.dirname(file));
  await writeFileAtomically(fileSystem, systemRandom, file, JSON.stringify(pointer), { mode: FILE_MODE });
};
