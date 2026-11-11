import path from 'node:path';
import { hostPaths, isRecord, nodeFileSystem, systemRandom, writeFileAtomically } from '@momonga/foundation';
import type { PathResolver } from '@momonga/foundation';
import { ConfigError } from './config-error.ts';
import type { SettingsWriterPorts } from './file-lock.ts';
import { isAbsentPathError, readJsonFile } from './json-file.ts';
import type { Confinement } from './json-file.ts';

const SETTINGS_FILE_MODE = 0o600;
const PRIVATE_DIRECTORY_MODE = 0o700;

export type EditUserSettingsOptions = SettingsWriterPorts & { confine?: Confinement };

const documentOf = async (settingsFile: string, confine: Confinement | undefined): Promise<Record<string, unknown>> => {
  const read = await readJsonFile(settingsFile, confine === undefined ? {} : { confine });
  if (!read.found) return {};
  if (!isRecord(read.value)) throw new ConfigError(`${settingsFile}: settings must be a JSON object`);
  return read.value;
};

export const settingsWriteTarget = async (file: string, paths: Pick<PathResolver, 'realPath'>): Promise<string> => {
  let isLink: boolean;
  try {
    isLink = (await nodeFileSystem.lstat(file)).isSymbolicLink();
  } catch (error) {
    if (isAbsentPathError(error)) return file;
    throw error;
  }
  if (!isLink) return file;
  try {
    return await paths.realPath(file);
  } catch (error) {
    if (isAbsentPathError(error)) throw new ConfigError(`${file}: dangling symlink`, { cause: error });
    throw error;
  }
};

export const editUserSettings = async (settingsFile: string, edit: (document: Record<string, unknown>) => boolean, { lock, randomHex, signal, confine }: EditUserSettingsOptions): Promise<void> => {
  const target = await settingsWriteTarget(settingsFile, hostPaths(signal));
  await nodeFileSystem.mkdir(path.dirname(target), PRIVATE_DIRECTORY_MODE);
  await lock.locked(target, signal, async () => {
    const document = await documentOf(settingsFile, confine);
    if (!edit(document)) return;
    await writeFileAtomically(nodeFileSystem, { ...systemRandom, hex: randomHex }, target, `${JSON.stringify(document, null, 2)}\n`, { mode: SETTINGS_FILE_MODE });
  });
};
