import path from 'node:path';
import { isRecord, writeFileAtomically } from '@momonga/foundation';
import { asked, askerOf } from './asker.ts';
import type { Asker } from './asker.ts';
import { ConfigError } from './config-error.ts';
import type { SettingsWriterPorts } from './file-lock.ts';
import { isAbsentPathError, readJsonFile } from './json-file.ts';
import type { Confinement } from './json-file.ts';

const SETTINGS_FILE_MODE = 0o600;
const PRIVATE_DIRECTORY_MODE = 0o700;

export type EditUserSettingsOptions = SettingsWriterPorts & { confine?: Confinement };

export type SettingsEdit = (document: Record<string, unknown>) => boolean | Promise<boolean>;

const documentOf = async (settingsFile: string, asker: Asker, confine: Confinement | undefined): Promise<Record<string, unknown>> => {
  const read = await readJsonFile(settingsFile, asker, confine === undefined ? {} : { confine });
  if (!read.found) return {};
  if (!isRecord(read.value)) throw new ConfigError(`${settingsFile}: settings must be a JSON object`);
  return read.value;
};

export const settingsWriteTarget = async (file: string, asker: Asker): Promise<string> => {
  let isLink: boolean;
  try {
    isLink = (await asked(asker, asker.files.lstat(file))).isSymbolicLink();
  } catch (error) {
    if (isAbsentPathError(error)) return file;
    throw error;
  }
  if (!isLink) return file;
  try {
    return await asker.paths.realPath(file);
  } catch (error) {
    if (isAbsentPathError(error)) throw new ConfigError(`${file}: dangling symlink`, { cause: error });
    throw error;
  }
};

export const editUserSettings = async (settingsFile: string, edit: SettingsEdit, { lock, random, signal, confine }: EditUserSettingsOptions): Promise<void> => {
  const asker = askerOf(signal);
  signal.throwIfAborted();
  const target = await settingsWriteTarget(settingsFile, asker);
  await asked(asker, asker.files.mkdir(path.dirname(target), PRIVATE_DIRECTORY_MODE));
  await lock.locked(target, signal, async () => {
    const document = await documentOf(settingsFile, asker, confine);
    if (!(await edit(document))) return;
    signal.throwIfAborted();
    await writeFileAtomically(asker.files, random, target, `${JSON.stringify(document, null, 2)}\n`, { mode: SETTINGS_FILE_MODE });
  });
};
