import path from 'node:path';
import { parseOutsideJson } from './json-depth.ts';
import { generationLayout, generationOfDirectoryName } from './momonga-paths.ts';
import type { MomongaPaths } from './momonga-paths.ts';
import { nodeFileSystem } from './node-file-system.ts';
import type { KernelLockMechanism } from './platform/kernel-lock.ts';

export type StartRecord = { version: string; foldVersion: number };

export type StartRecordRead = { kind: 'record'; record: StartRecord } | { kind: 'missing' } | { kind: 'unreadable'; reason: string };

export const START_RECORD_MODE = 0o600;

export const formatStartRecord = (record: StartRecord): string => `${JSON.stringify({ version: record.version, foldVersion: record.foldVersion })}\n`;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const codeOf = (error: unknown): string | undefined => (isRecord(error) && typeof error['code'] === 'string' ? error['code'] : undefined);

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const homeOf = (paths: MomongaPaths): string => path.dirname(paths.root);

export const parseStartRecord = (text: string): StartRecordRead => {
  let parsed: unknown;
  try {
    parsed = parseOutsideJson(text);
  } catch (error) {
    return { kind: 'unreadable', reason: `it is not JSON: ${messageOf(error)}` };
  }
  if (!isRecord(parsed)) return { kind: 'unreadable', reason: 'it is not an object' };
  const { version, foldVersion } = parsed;
  if (typeof version !== 'string' || version === '') return { kind: 'unreadable', reason: 'version is not a non-empty string' };
  if (typeof foldVersion !== 'number' || !Number.isSafeInteger(foldVersion)) return { kind: 'unreadable', reason: 'foldVersion is not a whole number' };
  return { kind: 'record', record: { version, foldVersion } };
};

export const readStartRecord = async (paths: MomongaPaths, generation: number): Promise<StartRecordRead> => {
  let text: string;
  try {
    text = await nodeFileSystem.readTextFile(generationLayout(homeOf(paths), generation).startRecord);
  } catch (error) {
    const code = codeOf(error);
    if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'missing' };
    return { kind: 'unreadable', reason: messageOf(error) };
  }
  return parseStartRecord(text);
};

export type LockProbeOptions = { lock: KernelLockMechanism; onProbeFailure?(lockPath: string, error: unknown): void };

export const lockReadsHeld = async (lockPath: string, options: LockProbeOptions): Promise<boolean> => {
  try {
    return await options.lock.isHeld(lockPath);
  } catch (error) {
    options.onProbeFailure?.(lockPath, error);
    return true;
  }
};

export type GenerationLocks = { supervisorHeld: boolean; startingHeld: boolean };

export const probeGenerationLocks = async (paths: MomongaPaths, generation: number, options: LockProbeOptions): Promise<GenerationLocks> => {
  const layout = generationLayout(homeOf(paths), generation);
  return { supervisorHeld: await lockReadsHeld(layout.locks.supervisor, options), startingHeld: await lockReadsHeld(layout.startingLock, options) };
};

export const generationIsLive = async (paths: MomongaPaths, generation: number, options: LockProbeOptions): Promise<boolean> => {
  const locks = await probeGenerationLocks(paths, generation, options);
  return locks.supervisorHeld || locks.startingHeld;
};

export type ListedGeneration = GenerationLocks & { generation: number; live: boolean; record: StartRecordRead };

export const listGenerationNumbers = async (paths: MomongaPaths, readdir: (directory: string) => Promise<string[]> = (directory) => nodeFileSystem.readdir(directory)): Promise<number[]> => {
  let names: string[];
  try {
    names = await readdir(paths.run);
  } catch (error) {
    if (codeOf(error) === 'ENOENT') return [];
    throw error;
  }
  return names
    .map(generationOfDirectoryName)
    .filter((generation): generation is number => generation !== undefined)
    .sort((left, right) => left - right);
};

export type ListGenerationsOptions = LockProbeOptions & { readdir?(directory: string): Promise<string[]> };

export const listGenerations = async (paths: MomongaPaths, options: ListGenerationsOptions): Promise<ListedGeneration[]> => {
  const listed: ListedGeneration[] = [];
  for (const generation of await listGenerationNumbers(paths, options.readdir)) {
    const locks = await probeGenerationLocks(paths, generation, options);
    listed.push({ generation, ...locks, live: locks.supervisorHeld || locks.startingHeld, record: await readStartRecord(paths, generation) });
  }
  return listed;
};
