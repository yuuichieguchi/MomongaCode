import path from 'node:path';
import { writeFileAtomically } from './atomic-file.ts';
import type { AtomicWriteFileSystem } from './atomic-file.ts';
import { hostKernelLock } from './platform/host-kernel-lock.ts';
import type { KernelLockMechanism } from './platform/kernel-lock.ts';
import { parseOutsideJson } from './json-depth.ts';
import { FIRST_GENERATION, generationLayout } from './momonga-paths.ts';
import type { GenerationLayout, GenerationRole, GenerationSockets, MomongaPaths } from './momonga-paths.ts';
import { nodeFileSystem } from './node-file-system.ts';
import { systemRandom } from './system-random.ts';
import { readStopRecord } from './stop-record.ts';
import type { StopValues } from './process-contract.ts';

export type CurrentGeneration = { generation: number; version: string; sockets: GenerationSockets };

const CURRENT_FILE_MODE = 0o600;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const malformed = (file: string, reason: string): Error => new Error(`${file} is not a current-generation record: ${reason}`);

const socketsOf = (file: string, value: unknown): GenerationSockets => {
  if (!isRecord(value)) throw malformed(file, 'sockets is not an object');
  const socketOf = (role: GenerationRole): string => {
    const socket = value[role];
    if (typeof socket !== 'string' || socket === '') throw malformed(file, `sockets.${role} is not a non-empty string`);
    return socket;
  };
  return { gateway: socketOf('gateway'), runtime: socketOf('runtime'), supervisor: socketOf('supervisor') };
};

const recordOf = (file: string, text: string): CurrentGeneration => {
  const parsed: unknown = parseOutsideJson(text);
  if (!isRecord(parsed)) throw malformed(file, 'it is not an object');
  const { generation, version, sockets } = parsed;
  if (typeof generation !== 'number' || !Number.isSafeInteger(generation) || generation < 1) throw malformed(file, 'generation is not a positive integer');
  if (typeof version !== 'string' || version === '') throw malformed(file, 'version is not a non-empty string');
  return { generation, version, sockets: socketsOf(file, sockets) };
};

const isMissing = (error: unknown): boolean => isRecord(error) && error['code'] === 'ENOENT';

export const readCurrentGeneration = async (paths: MomongaPaths): Promise<CurrentGeneration | undefined> => {
  let text: string;
  try {
    text = await nodeFileSystem.readTextFile(paths.current);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
  return recordOf(paths.current, text);
};

export const publishCurrentGeneration = async (
  paths: MomongaPaths,
  record: CurrentGeneration,
  fs: AtomicWriteFileSystem = nodeFileSystem,
  lock: KernelLockMechanism = hostKernelLock(),
): Promise<void> => {
  const content = `${JSON.stringify({ generation: record.generation, version: record.version, sockets: record.sockets })}\n`;
  await writeFileAtomically(fs, systemRandom, paths.current, content, { mode: CURRENT_FILE_MODE, lock });
};

export class NoCurrentGenerationError extends Error {
  readonly code = 'ENOENT';
  readonly path: string;

  constructor(file: string) {
    super(`no daemon generation is current: ${file} does not exist`);
    this.name = 'NoCurrentGenerationError';
    this.path = file;
  }
}

const requireCurrentGeneration = async (paths: MomongaPaths): Promise<CurrentGeneration> => {
  const record = await readCurrentGeneration(paths);
  if (record === undefined) throw new NoCurrentGenerationError(paths.current);
  return record;
};

export const currentSocketResolver =
  (paths: MomongaPaths, role: GenerationRole): (() => Promise<string>) =>
  async () =>
    (await requireCurrentGeneration(paths)).sockets[role];

const homeOf = (paths: MomongaPaths): string => path.dirname(paths.root);

export const readCurrentStopRecord = async (paths: MomongaPaths): Promise<StopValues | undefined> => {
  const current = await readCurrentGeneration(paths);
  if (current === undefined) return undefined;
  return readStopRecord(generationLayout(homeOf(paths), current.generation).stopRecord);
};

const soughtGeneration = async (paths: MomongaPaths): Promise<Pick<GenerationLayout, 'sockets' | 'locks'>> => {
  const record = await readCurrentGeneration(paths);
  if (record === undefined) return generationLayout(homeOf(paths), FIRST_GENERATION);
  return { sockets: record.sockets, locks: generationLayout(homeOf(paths), record.generation).locks };
};

export const startingSocketResolver =
  (paths: MomongaPaths, role: GenerationRole): (() => Promise<string>) =>
  async () =>
    (await soughtGeneration(paths)).sockets[role];

export const currentGenerationLock = async (paths: MomongaPaths, role: GenerationRole): Promise<string> => (await soughtGeneration(paths)).locks[role];
