import path from 'node:path';
import { writeFileAtomically } from './atomic-file.ts';
import { nodeFileSystem } from './node-file-system.ts';
import { parseOutsideJson } from './json-depth.ts';
import { parseStopValues } from './process-contract.ts';
import type { StopValues } from './process-contract.ts';
import type { KernelLockMechanism } from './platform/kernel-lock.ts';
import { systemRandom } from './system-random.ts';

const STOP_RECORD_MODE = 0o600;

const GENERATION_DIRECTORY = /^g([1-9]\d*)$/;

const RECORD_FIELDS = ['generation', 'values'];

export const writeStopRecord = async (file: string, generation: number, values: StopValues, lock: KernelLockMechanism): Promise<void> => {
  await writeFileAtomically(nodeFileSystem, systemRandom, file, `${JSON.stringify({ generation, values })}\n`, { mode: STOP_RECORD_MODE, lock });
};

const generationOfDirectory = (file: string): number | undefined => {
  const match = GENERATION_DIRECTORY.exec(path.basename(path.dirname(file)));
  return match === null ? undefined : Number(match[1]);
};

const readRecordText = async (file: string): Promise<string | undefined> => {
  try {
    const stat = await nodeFileSystem.lstat(file);
    if (!stat.isFile()) return undefined;
    return await nodeFileSystem.readTextFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
};

const parseRecord = (text: string): unknown => {
  try {
    return parseOutsideJson(text);
  } catch {
    return undefined;
  }
};

export const readStopRecord = async (file: string): Promise<StopValues | undefined> => {
  const generation = generationOfDirectory(file);
  if (generation === undefined) return undefined;
  const text = await readRecordText(file);
  if (text === undefined) return undefined;
  const record = parseRecord(text);
  if (typeof record !== 'object' || record === null || Array.isArray(record)) return undefined;
  const fields = record as Readonly<Record<string, unknown>>;
  if (Object.keys(fields).some((key) => !RECORD_FIELDS.includes(key))) return undefined;
  if (fields['generation'] !== generation) return undefined;
  const parsed = parseStopValues(fields['values']);
  if (parsed.kind !== 'values') return undefined;
  if (Object.keys(fields['values'] as object).length !== Object.keys(parsed.values).length) return undefined;
  return parsed.values;
};
