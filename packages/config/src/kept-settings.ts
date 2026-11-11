import path from 'node:path';
import { canonicalJson, isRecord, settledOrAborted, sha256Hex, writeFileAtomically } from '@momonga/foundation';
import type { FileSystem, KernelLockMechanism, Random } from '@momonga/foundation';
import type { ConfigError } from './config-error.ts';
import { isAbsentPathError, parseJsonText } from './json-file.ts';
import type { JsonFile } from './json-file.ts';
import type { Kept } from './last-good.ts';
import { layoutOf } from './layout.ts';

const KEPT_DIRECTORY_MODE = 0o700;
const KEPT_FILE_MODE = 0o600;

export type KeptSettings = {
  recall(file: string, signal: AbortSignal): Promise<Kept<JsonFile>>;
  remember(file: string, read: JsonFile, signal: AbortSignal): Promise<void>;
  report(file: string, problem: KeptProblem): string;
};

export type KeptProblem = { kind: 'invalid'; error: ConfigError; identity: string } | { kind: 'unkept'; reason: string } | { kind: 'unusable'; reason: string };

export type KeptRecords = {
  load(file: string, signal: AbortSignal): Promise<JsonFile | undefined>;
  save(file: string, read: JsonFile, signal: AbortSignal): Promise<void>;
};

export type KeptSettingsOptions = { records: KeptRecords; onWarning: (message: string) => void };

export const keptSettingsDirectory = (home: string): string => path.join(layoutOf(home).state, 'settings-kept');

export class UnreadableKeptCopyError extends Error {}

const isJsonFile = (value: unknown): value is JsonFile =>
  isRecord(value) && (value['found'] === false || (value['found'] === true && Object.hasOwn(value, 'value')));

export const diskKeptRecords = (files: FileSystem, random: Random, directory: string, lock: KernelLockMechanism): KeptRecords => {
  const recordOf = (file: string): string => path.join(directory, `${sha256Hex(file)}.json`);
  return {
    load: async (file, signal) => {
      signal.throwIfAborted();
      const record = recordOf(file);
      let text: string | undefined;
      try {
        text = await settledOrAborted(files.readOwnerOnlyTextFile(record, `the kept copy ${record}`), signal);
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        if (isAbsentPathError(error)) return undefined;
        if (error instanceof Error && !('code' in error)) throw new UnreadableKeptCopyError(error.message, { cause: error });
        throw error;
      }
      if (text === undefined) return undefined;
      let kept: unknown;
      try {
        kept = parseJsonText(text, record);
      } catch (error) {
        throw new UnreadableKeptCopyError(error instanceof Error ? error.message : String(error), { cause: error });
      }
      if (!isRecord(kept) || kept['file'] !== file || !isJsonFile(kept['read'])) throw new UnreadableKeptCopyError(`${record}: not a kept copy of ${file}`);
      return kept['read'];
    },
    save: async (file, read, signal) => {
      signal.throwIfAborted();
      await settledOrAborted(files.mkdir(directory, KEPT_DIRECTORY_MODE), signal);
      signal.throwIfAborted();
      await writeFileAtomically(files, random, recordOf(file), `${JSON.stringify({ file, read })}\n`, { mode: KEPT_FILE_MODE, lock });
    },
  };
};

export const noKeptRecords: KeptRecords = { load: async () => undefined, save: async () => undefined };

const lineOf = (file: string, problem: KeptProblem): string =>
  problem.kind === 'invalid'
    ? `settings file is invalid: ${problem.error.message}`
    : problem.kind === 'unkept'
      ? `could not keep the last good copy of ${file}: ${problem.reason}`
      : `the last good copy of ${file} is unusable and was ignored: ${problem.reason}`;

const keyOf = (problem: KeptProblem): string =>
  problem.kind === 'invalid' ? `${problem.identity}\u0000${problem.error.message}` : problem.reason;

export function createKeptSettings({ records, onWarning }: KeptSettingsOptions): KeptSettings {
  const copies = new Map<string, JsonFile>();
  const reported = new Map<string, string>();
  const slotOf = (file: string, kind: KeptProblem['kind']): string => `${kind}\u0000${file}`;

  const report = (file: string, problem: KeptProblem): string => {
    const line = lineOf(file, problem);
    const slot = slotOf(file, problem.kind);
    const key = keyOf(problem);
    if (reported.get(slot) !== key) {
      reported.set(slot, key);
      onWarning(line);
    }
    return line;
  };

  const saved = async (file: string, read: JsonFile, signal: AbortSignal): Promise<void> => {
    try {
      await records.save(file, read, signal);
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      report(file, { kind: 'unkept', reason: error instanceof Error ? error.message : String(error) });
      return;
    }
    reported.delete(slotOf(file, 'unkept'));
    reported.delete(slotOf(file, 'unusable'));
  };

  const loaded = async (file: string, signal: AbortSignal): Promise<JsonFile | undefined> => {
    try {
      return await records.load(file, signal);
    } catch (error) {
      if (!(error instanceof UnreadableKeptCopyError)) throw error;
      report(file, { kind: 'unusable', reason: error.message });
      return undefined;
    }
  };

  return {
    recall: async (file, signal) => {
      const known = copies.get(file) ?? (await loaded(file, signal));
      if (known === undefined) return undefined;
      copies.set(file, known);
      return { value: known };
    },
    remember: async (file, read, signal) => {
      reported.delete(slotOf(file, 'invalid'));
      const known = copies.get(file);
      if (known !== undefined && canonicalJson(known) === canonicalJson(read)) return;
      copies.set(file, read);
      await saved(file, read, signal);
    },
    report,
  };
}
