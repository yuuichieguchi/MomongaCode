import fs from 'node:fs';
import path from 'node:path';
import { isAtomicWriteTemporary } from './atomic-file.ts';
import { isRecord } from './json.ts';
import { JsonDepthError, parseOutsideJson } from './json-depth.ts';
import type { LeftoverDirectory } from './leftover-sweep.ts';
import { isProcessAlive } from './process-alive.ts';

export const HANDOVER_DIRECTORY = 'handover';
export const HANDOVER_RECORD_SUFFIX = '.json';
export const HANDOVER_RECORD_MAX_BYTES = 1024 * 1024;
export const HANDOVER_RECORD_OWNER_FIELD = 'pid';

export const handoverDirectoryOf = (paths: { readonly run: string }): string => path.join(paths.run, HANDOVER_DIRECTORY);

const isRecordName = (name: string): boolean => name.endsWith(HANDOVER_RECORD_SUFFIX);

const jsonOf = (text: string): unknown => {
  try {
    return parseOutsideJson(text);
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof JsonDepthError) return undefined;
    throw error;
  }
};

export const handoverRecordOwner = (text: string): number | undefined => {
  const parsed = jsonOf(text);
  if (!isRecord(parsed)) return undefined;
  const owner = parsed[HANDOVER_RECORD_OWNER_FIELD];
  return typeof owner === 'number' && Number.isSafeInteger(owner) && owner > 0 ? owner : undefined;
};

const textOfRecord = (file: string): string | undefined => {
  let descriptor: number;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  try {
    if (fs.fstatSync(descriptor).size > HANDOVER_RECORD_MAX_BYTES) return undefined;
    return fs.readFileSync(descriptor, 'utf8');
  } finally {
    fs.closeSync(descriptor);
  }
};

export type ProcessProbe = (pid: number) => boolean;

export const handoverLeftovers = (paths: { readonly run: string }, alive: ProcessProbe = (pid) => isProcessAlive(pid)): LeftoverDirectory => {
  const directory = handoverDirectoryOf(paths);
  return {
    directory,
    isLeftover: (name) => isRecordName(name) || isAtomicWriteTemporary(name),
    retain: (name) => {
      if (!isRecordName(name)) return false;
      const text = textOfRecord(path.join(directory, name));
      const owner = text === undefined ? undefined : handoverRecordOwner(text);
      return owner !== undefined && alive(owner);
    },
  };
};
