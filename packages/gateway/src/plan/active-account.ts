import fs from 'node:fs/promises';
import path from 'node:path';
import { isRecord, nodeFileSystem, systemRandom, writeFileAtomically } from '@momonga/foundation';

type ActivePointer = Record<string, string>;

const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;

const readPointer = async (file: string): Promise<ActivePointer> => {
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
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

export const readActiveAccount = async (file: string, profile: string): Promise<string | undefined> => {
  const pointer = await readPointer(file);
  return Object.hasOwn(pointer, profile) ? pointer[profile] : undefined;
};

export const writeActiveAccount = async (file: string, profile: string, account: string): Promise<void> => {
  const pointer = await readPointer(file);
  const directory = path.dirname(file);
  await fs.mkdir(directory, { recursive: true, mode: DIRECTORY_MODE });
  await writeFileAtomically(nodeFileSystem, systemRandom, file, JSON.stringify({ ...pointer, [profile]: account }), { mode: FILE_MODE });
};
