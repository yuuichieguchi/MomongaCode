import path from 'node:path';
import { comparablePath, createKeyedSerializer, isRecord, nodeFileSystem, systemFileLockPorts, systemRandom, withFileLock, writeFileAtomically } from '@momonga/foundation';
import type { FileLockPorts } from '@momonga/foundation';
import { settingsLockPath } from './file-lock.ts';
import { readJsonFile } from './json-file.ts';
import { layoutOf } from './layout.ts';

const SETTINGS_FILE_MODE = 0o600;
const PRIVATE_DIRECTORY_MODE = 0o700;

const serializeInProcess = createKeyedSerializer();

export type EditUserSettingsOptions = { ports?: FileLockPorts; lockTimeoutMs?: number; signal?: AbortSignal };

const documentOf = async (settingsFile: string): Promise<Record<string, unknown>> => {
  const read = await readJsonFile(settingsFile);
  if (!read.found) return {};
  if (!isRecord(read.value)) throw new Error(`${settingsFile}: settings must be a JSON object`);
  return read.value;
};

export const editUserSettings = async (
  home: string,
  settingsFile: string,
  edit: (document: Record<string, unknown>) => boolean,
  options: EditUserSettingsOptions = {},
): Promise<void> => {
  const ports = options.ports ?? systemFileLockPorts;
  await nodeFileSystem.mkdir(path.dirname(settingsFile), PRIVATE_DIRECTORY_MODE);
  await nodeFileSystem.mkdir(layoutOf(home).run, PRIVATE_DIRECTORY_MODE);
  await serializeInProcess(comparablePath(settingsFile), () =>
    withFileLock(
      settingsLockPath(home, settingsFile),
      async () => {
        const document = await documentOf(settingsFile);
        if (!edit(document)) return;
        await writeFileAtomically(nodeFileSystem, { ...systemRandom, hex: ports.randomHex }, settingsFile, `${JSON.stringify(document, null, 2)}\n`, { mode: SETTINGS_FILE_MODE });
      },
      { ports, ...(options.lockTimeoutMs === undefined ? {} : { timeoutMs: options.lockTimeoutMs }), ...(options.signal === undefined ? {} : { signal: options.signal }) },
    ),
  );
};
