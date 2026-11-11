import path from 'node:path';
import { DEFAULT_LOCK_TIMEOUT_MS, createKeyedSerializer, hostPaths, isRecord, nodeFileSystem, systemFileLockPorts, withFileLock, writeFileAtomically } from '@momonga/foundation';
import type { FileLockPorts, PathResolver } from '@momonga/foundation';
import { settingsLockPath } from './file-lock.ts';
import { isAbsentPathError, readJsonFile } from './json-file.ts';
import { layoutOf } from './layout.ts';

const SETTINGS_FILE_MODE = 0o600;
const PRIVATE_DIRECTORY_MODE = 0o700;

const serializeInProcess = createKeyedSerializer();

export type EditUserSettingsOptions = { ports?: FileLockPorts; lockTimeoutMs?: number; signal: AbortSignal };

const documentOf = async (settingsFile: string): Promise<Record<string, unknown>> => {
  const read = await readJsonFile(settingsFile);
  if (!read.found) return {};
  if (!isRecord(read.value)) throw new Error(`${settingsFile}: settings must be a JSON object`);
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
    if (isAbsentPathError(error)) throw new Error(`${file}: dangling symlink`, { cause: error });
    throw error;
  }
};

export const editUserSettings = async (
  home: string,
  settingsFile: string,
  edit: (document: Record<string, unknown>) => boolean,
  options: EditUserSettingsOptions,
): Promise<void> => {
  const ports = options.ports ?? systemFileLockPorts;
  const paths = hostPaths(options.signal);
  const target = await settingsWriteTarget(settingsFile, paths);
  await nodeFileSystem.mkdir(path.dirname(target), PRIVATE_DIRECTORY_MODE);
  await nodeFileSystem.mkdir(layoutOf(home).run, PRIVATE_DIRECTORY_MODE);
  const lockPath = await settingsLockPath(home, target, paths);
  await serializeInProcess(
    await paths.comparablePath(target),
    () =>
      withFileLock(
        lockPath,
        async () => {
          const document = await documentOf(settingsFile);
          if (!edit(document)) return;
          await writeFileAtomically(nodeFileSystem, ports.random, target, `${JSON.stringify(document, null, 2)}\n`, { mode: SETTINGS_FILE_MODE });
        },
        { ports, signal: options.signal, timeoutMs: options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS },
      ),
    options.signal,
  );
};
