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

type Stored = { kind: 'absent' } | { kind: 'read'; notices: DismissedNotices } | { kind: 'unreadable'; text: string };

const storedIn = async (files: Pick<CliFiles, 'readTextIfPresent'>, file: string): Promise<Stored> => {
  const text = await files.readTextIfPresent(file);
  if (text === undefined) return { kind: 'absent' };
  const value = parsed(text);
  return isDismissedNotices(value) ? { kind: 'read', notices: value } : { kind: 'unreadable', text };
};

export const readDismissedNotices = async (files: Pick<CliFiles, 'readTextIfPresent'>, stateDirectory: string, warn: (warning: string) => void): Promise<DismissedNotices> => {
  const file = fileIn(stateDirectory);
  const stored = await storedIn(files, file);
  if (stored.kind === 'read') return stored.notices;
  if (stored.kind === 'unreadable') warn(`${file} is not a map of notice keys to times and was ignored; the next dismissal keeps it under another name and starts a new file`);
  return {};
};

const setAside = async (files: Pick<CliFiles, 'writeTextAtomically'>, file: string, text: string, at: Date, warn: (warning: string) => void): Promise<void> => {
  const kept = `${file}.unreadable-${at.getTime()}`;
  await files.writeTextAtomically(kept, text, FILE_MODE);
  warn(`${file} is not a map of notice keys to times; it is kept as ${kept} and a new file is started`);
};

export const dismissNotice = (
  files: Pick<CliFiles, 'readTextIfPresent' | 'mkdirPrivate' | 'writeTextAtomically'>,
  stateDirectory: string,
  key: string,
  at: Date,
  signal: AbortSignal,
  warn: (warning: string) => void,
): Promise<void> =>
  serializeInProcess(
    fileIn(stateDirectory),
    async () => {
      const file = fileIn(stateDirectory);
      const stored = await storedIn(files, file);
      if (stored.kind === 'unreadable') await setAside(files, file, stored.text, at, warn);
      await files.mkdirPrivate(stateDirectory);
      await files.writeTextAtomically(file, `${JSON.stringify({ ...(stored.kind === 'read' ? stored.notices : {}), [key]: at.toISOString() })}\n`, FILE_MODE);
    },
    signal,
  );
