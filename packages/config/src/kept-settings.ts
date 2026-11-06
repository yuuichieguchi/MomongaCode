import path from 'node:path';
import { canonicalJson, isRecord, sha256Hex, systemRandom, writeFileAtomicallySync } from '@momonga/foundation';
import type { FileSystemSync } from '@momonga/foundation';
import type { ConfigError } from './config-error.ts';
import { isAbsentPathError } from './json-file.ts';
import type { JsonFile } from './json-file.ts';
import type { Kept } from './last-good.ts';
import { layoutOf } from './layout.ts';

const KEPT_DIRECTORY_MODE = 0o700;
const KEPT_FILE_MODE = 0o600;

export type KeptSettings = {
  recall(file: string): Kept<JsonFile>;
  remember(file: string, read: JsonFile): void;
  report(file: string, error: ConfigError, identity: string): string;
};

export type KeptRecords = {
  load(file: string): JsonFile | undefined;
  save(file: string, read: JsonFile): void;
};

export type KeptSettingsOptions = { records: KeptRecords; onWarning: (message: string) => void };

export const keptSettingsDirectory = (home: string): string => path.join(layoutOf(home).state, 'settings-kept');

const isJsonFile = (value: unknown): value is JsonFile =>
  isRecord(value) && (value['found'] === false || (value['found'] === true && Object.hasOwn(value, 'value')));

export const diskKeptRecords = (fileSystem: FileSystemSync, directory: string): KeptRecords => {
  const recordOf = (file: string): string => path.join(directory, `${sha256Hex(file)}.json`);
  return {
    load: (file) => {
      let handle: number;
      try {
        handle = fileSystem.openReadNoFollowSync(recordOf(file));
      } catch (error) {
        if (isAbsentPathError(error)) return undefined;
        throw error;
      }
      let bytes: Uint8Array;
      try {
        bytes = fileSystem.readFileSync(handle);
      } finally {
        fileSystem.closeSync(handle);
      }
      const record: unknown = JSON.parse(new TextDecoder().decode(bytes));
      if (!isRecord(record) || record['file'] !== file || !isJsonFile(record['read'])) throw new Error(`${recordOf(file)} is not a kept copy of ${file}`);
      return record['read'];
    },
    save: (file, read) => {
      fileSystem.mkdirSync(directory, KEPT_DIRECTORY_MODE);
      writeFileAtomicallySync(fileSystem, systemRandom, recordOf(file), `${JSON.stringify({ file, read })}\n`, { mode: KEPT_FILE_MODE });
    },
  };
};

export const noKeptRecords: KeptRecords = { load: () => undefined, save: () => undefined };

export function createKeptSettings({ records, onWarning }: KeptSettingsOptions): KeptSettings {
  const copies = new Map<string, JsonFile>();
  const warned = new Map<string, string>();
  const unkept = new Map<string, string>();

  const saved = (file: string, read: JsonFile): void => {
    try {
      records.save(file, read);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (unkept.get(file) === reason) return;
      unkept.set(file, reason);
      onWarning(`could not keep the last good copy of ${file}: ${reason}`);
      return;
    }
    unkept.delete(file);
  };

  return {
    recall: (file) => {
      const known = copies.get(file) ?? records.load(file);
      if (known === undefined) return undefined;
      copies.set(file, known);
      return { value: known };
    },
    remember: (file, read) => {
      warned.delete(file);
      const known = copies.get(file);
      if (known !== undefined && canonicalJson(known) === canonicalJson(read)) return;
      copies.set(file, read);
      saved(file, read);
    },
    report: (file, error, identity) => {
      const notice = `settings file is invalid: ${error.message}`;
      const key = `${identity}\u0000${error.message}`;
      if (warned.get(file) !== key) {
        warned.set(file, key);
        onWarning(notice);
      }
      return notice;
    },
  };
}
