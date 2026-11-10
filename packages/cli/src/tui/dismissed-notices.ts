import path from 'node:path';
import { createKeyedSerializer, isRecord } from '@momonga/foundation';
import type { CliFiles } from '../ports.ts';

export type DismissedNotices = Readonly<Record<string, string>>;

const FILE_NAME = 'dismissed-notices.json';
const FILE_MODE = 0o600;

const serializeInProcess = createKeyedSerializer();

const fileIn = (stateDirectory: string): string => path.join(stateDirectory, FILE_NAME);

const isDismissedNotices = (value: unknown): value is DismissedNotices => isRecord(value) && Object.values(value).every((time) => typeof time === 'string');

const parsed = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

export const readDismissedNotices = async (files: Pick<CliFiles, 'readTextIfPresent'>, stateDirectory: string, warn: (warning: string) => void): Promise<DismissedNotices> => {
  const file = fileIn(stateDirectory);
  const text = await files.readTextIfPresent(file);
  if (text === undefined) return {};
  const value = parsed(text);
  if (!isDismissedNotices(value)) {
    warn(`${file} is not a map of notice keys to times and was ignored; delete it to dismiss notices again`);
    return {};
  }
  return value;
};

export const dismissNotice = (files: Pick<CliFiles, 'readTextIfPresent' | 'mkdirPrivate' | 'writeTextAtomically'>, stateDirectory: string, key: string, at: Date): Promise<void> =>
  serializeInProcess(fileIn(stateDirectory), async () => {
    const earlier = await readDismissedNotices(files, stateDirectory, () => undefined);
    await files.mkdirPrivate(stateDirectory);
    await files.writeTextAtomically(fileIn(stateDirectory), `${JSON.stringify({ ...earlier, [key]: at.toISOString() })}\n`, FILE_MODE);
  });
