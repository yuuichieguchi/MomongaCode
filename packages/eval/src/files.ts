import fs from 'node:fs/promises';
import path from 'node:path';
import { nodeFileSystem } from '@momonga/foundation';
import type { FileSystem } from '@momonga/foundation';
import { parseContextDataset } from './context-dataset.ts';
import type { ContextDataset } from './context-dataset.ts';
import { encodeContextReport, parseContextReport } from './context-report.ts';
import type { ContextReport } from './context-report.ts';
import { parseDataset } from './dataset.ts';
import type { GoldenDataset } from './dataset.ts';
import { decodeTranscript, encodeTranscript } from './transcript.ts';
import type { Transcript } from './transcript.ts';
import { parseYieldDataset } from './yield-dataset.ts';
import type { YieldDataset } from './yield-dataset.ts';
import { encodeYieldReport } from './yield-report.ts';
import type { YieldReport } from './yield-report.ts';

export type EvalFiles = {
  readText(file: string): Promise<string>;
  writeText(file: string, text: string): Promise<void>;
  listFiles(directory: string): Promise<string[]>;
  exists(file: string): Promise<boolean>;
};

export type WorkspaceFiles = Pick<FileSystem, 'stat' | 'lstat' | 'readdir' | 'readdirEntries' | 'readFile' | 'readTextFile' | 'mkdir' | 'writeFile' | 'access' | 'realpath' | 'cp'> & {
  removeExisting(file: string): Promise<void>;
};

export const nodeWorkspaceFiles: WorkspaceFiles = {
  stat: nodeFileSystem.stat,
  lstat: nodeFileSystem.lstat,
  readdir: nodeFileSystem.readdir,
  readdirEntries: nodeFileSystem.readdirEntries,
  readFile: nodeFileSystem.readFile,
  readTextFile: nodeFileSystem.readTextFile,
  mkdir: nodeFileSystem.mkdir,
  writeFile: nodeFileSystem.writeFile,
  access: nodeFileSystem.access,
  realpath: nodeFileSystem.realpath,
  cp: nodeFileSystem.cp,
  removeExisting: (file) => fs.rm(file),
};

const TRANSCRIPT_FILE_SUFFIX = '.transcript.jsonl';
const TRANSCRIPT_FILE_MODE = 0o600;

export const nodeEvalFiles: EvalFiles = {
  readText: (file) => fs.readFile(file, 'utf8'),
  writeText: (file, text) => fs.writeFile(file, text, { mode: TRANSCRIPT_FILE_MODE, flag: 'wx' }),
  listFiles: async (directory) => (await fs.readdir(directory)).sort().map((name) => path.join(directory, name)),
  exists: async (file) => {
    try {
      await nodeFileSystem.lstat(file);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  },
};

export class OutputExistsError extends Error {
  constructor(file: string) {
    super(`${file} already exists, and a result is never written over another: name a file that does not exist`);
    this.name = 'OutputExistsError';
  }
}

export const refuseExistingOutput = async (files: Pick<EvalFiles, 'exists'>, file: string): Promise<void> => {
  if (await files.exists(file)) throw new OutputExistsError(file);
};

export const refuseRecordedTranscripts = async (files: Pick<EvalFiles, 'exists' | 'listFiles'>, directory: string): Promise<void> => {
  if (!(await files.exists(directory))) return;
  const recorded = (await files.listFiles(directory)).find((file) => file.endsWith(TRANSCRIPT_FILE_SUFFIX));
  if (recorded !== undefined) throw new OutputExistsError(recorded);
};

export const loadDataset = async (files: EvalFiles, file: string): Promise<GoldenDataset> => parseDataset(await files.readText(file), file);

export const loadContextDataset = async (files: EvalFiles, file: string): Promise<ContextDataset> => parseContextDataset(await files.readText(file), file);

export const loadContextReport = async (files: EvalFiles, file: string): Promise<ContextReport> => parseContextReport(await files.readText(file), file);

export const saveContextReport = (files: EvalFiles, file: string, report: ContextReport): Promise<void> => files.writeText(file, encodeContextReport(report));

export const loadYieldDataset = async (files: EvalFiles, file: string): Promise<YieldDataset> => parseYieldDataset(await files.readText(file), file);

export const saveYieldReport = (files: EvalFiles, file: string, report: YieldReport): Promise<void> => files.writeText(file, encodeYieldReport(report));

export const transcriptFileName = (transcript: Transcript): string => `${transcript.caseId}.${transcript.runIndex}${TRANSCRIPT_FILE_SUFFIX}`;

export const saveTranscript = async (files: EvalFiles, directory: string, transcript: Transcript): Promise<string> => {
  const file = path.join(directory, transcriptFileName(transcript));
  await files.writeText(file, encodeTranscript(transcript));
  return file;
};

export const loadTranscripts = async (files: EvalFiles, directory: string): Promise<Transcript[]> => {
  const names = (await files.listFiles(directory)).filter((file) => file.endsWith(TRANSCRIPT_FILE_SUFFIX));
  return Promise.all(names.map(async (file) => decodeTranscript(await files.readText(file), file)));
};
