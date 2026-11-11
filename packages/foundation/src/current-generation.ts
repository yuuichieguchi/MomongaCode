import path from 'node:path';
import { writeFileAtomically } from './atomic-file.ts';
import type { AtomicWriteFileSystem } from './atomic-file.ts';
import type { KernelLockMechanism } from './platform/kernel-lock.ts';
import { parseOutsideJson } from './json-depth.ts';
import { listGenerations } from './generation-registry.ts';
import type { ListGenerationsOptions } from './generation-registry.ts';
import { generationLayout } from './momonga-paths.ts';
import type { GenerationProcessRole, GenerationSockets, MomongaPaths } from './momonga-paths.ts';
import { nodeFileSystem } from './node-file-system.ts';
import { systemRandom } from './system-random.ts';

export type CurrentGeneration = { generation: number; version: string; sockets: GenerationSockets };

const CURRENT_FILE_MODE = 0o600;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

export class CurrentGenerationMalformedError extends Error {
  readonly reason: string;

  constructor(file: string, reason: string) {
    super(`${file} is not a current-generation record: ${reason}`);
    this.name = 'CurrentGenerationMalformedError';
    this.reason = reason;
  }
}

const malformed = (file: string, reason: string): Error => new CurrentGenerationMalformedError(file, reason);

const socketsOf = (file: string, value: unknown): GenerationSockets => {
  if (!isRecord(value)) throw malformed(file, 'sockets is not an object');
  const socketOf = (role: GenerationProcessRole): string => {
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

export type PublishOutcome = 'published' | 'superseded' | 'busy';

export type PublishOptions = { lock: KernelLockMechanism; fs?: AtomicWriteFileSystem };

export const formatCurrentGeneration = (record: CurrentGeneration): string => `${JSON.stringify({ generation: record.generation, version: record.version, sockets: record.sockets })}\n`;

export const publishCurrentGeneration = async (paths: MomongaPaths, record: CurrentGeneration, options: PublishOptions): Promise<PublishOutcome> => {
  const lock = options.lock;
  const claim = await lock.claim(paths.generationLock);
  if (claim.kind === 'held') return 'busy';
  try {
    const current = await readCurrentGeneration(paths);
    if (current !== undefined && record.generation <= current.generation) return 'superseded';
    await writeFileAtomically(options.fs ?? nodeFileSystem, systemRandom, paths.current, formatCurrentGeneration(record), { mode: CURRENT_FILE_MODE, lock });
    return 'published';
  } finally {
    claim.lock.release();
  }
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
  (paths: MomongaPaths, role: GenerationProcessRole): (() => Promise<string>) =>
  async () =>
    (await requireCurrentGeneration(paths)).sockets[role];

const homeOf = (paths: MomongaPaths): string => path.dirname(paths.root);

export class NoGenerationOfVersionError extends Error {
  readonly code = 'ENOENT';

  constructor(version: string) {
    super(`no running daemon generation is of version ${version}`);
    this.name = 'NoGenerationOfVersionError';
  }
}

export type ResolvedGeneration = { generation: number; version: string; sockets: GenerationSockets };

export const resolveGenerationFor = async (paths: MomongaPaths, version: string, options: ListGenerationsOptions): Promise<ResolvedGeneration | undefined> => {
  const current = await readCurrentGeneration(paths);
  if (current !== undefined && current.version === version) return current;
  const sameVersion = (await listGenerations(paths, options)).filter((listed) => listed.live && listed.record.kind === 'record' && listed.record.record.version === version);
  const newest = sameVersion.at(-1);
  return newest === undefined ? undefined : { generation: newest.generation, version, sockets: generationLayout(homeOf(paths), newest.generation).sockets };
};

export const versionSocketResolver =
  (paths: MomongaPaths, version: string, role: GenerationProcessRole, options: ListGenerationsOptions): (() => Promise<string>) =>
  async () => {
    const own = await resolveGenerationFor(paths, version, options);
    if (own === undefined) throw new NoGenerationOfVersionError(version);
    return own.sockets[role];
  };
