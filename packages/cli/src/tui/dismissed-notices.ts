import fs from 'node:fs';
import path from 'node:path';
import { createKeyedSerializer, isRecord, nodeFileSystem, systemRandom, writeFileAtomically } from '@momonga/foundation';

export type DismissedNotices = Readonly<Record<string, string>>;

const FILE_NAME = 'dismissed-notices.json';
const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;

const serializeInProcess = createKeyedSerializer();

const fileIn = (stateDirectory: string): string => path.join(stateDirectory, FILE_NAME);

const isDismissedNotices = (value: unknown): value is DismissedNotices => isRecord(value) && Object.values(value).every((time) => typeof time === 'string');

const readText = async (file: string): Promise<string | undefined> => {
  try {
    return await fs.promises.readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
};

const parsed = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

export const readDismissedNotices = async (stateDirectory: string, warn: (warning: string) => void): Promise<DismissedNotices> => {
  const file = fileIn(stateDirectory);
  const text = await readText(file);
  if (text === undefined) return {};
  const value = parsed(text);
  if (!isDismissedNotices(value)) {
    warn(`${file} is not a map of notice keys to times and was ignored; delete it to dismiss notices again`);
    return {};
  }
  return value;
};

export const dismissNotice = (stateDirectory: string, key: string, at: Date): Promise<void> =>
  serializeInProcess(fileIn(stateDirectory), async () => {
    const file = fileIn(stateDirectory);
    const earlier = await readDismissedNotices(stateDirectory, () => undefined);
    await fs.promises.mkdir(stateDirectory, { recursive: true, mode: DIRECTORY_MODE });
    await writeFileAtomically(nodeFileSystem, systemRandom, file, `${JSON.stringify({ ...earlier, [key]: at.toISOString() })}\n`, { mode: FILE_MODE });
  });
