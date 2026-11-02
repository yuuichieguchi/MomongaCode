import fs from 'node:fs/promises';
import path from 'node:path';
import { parseDataset } from './dataset.ts';
import type { GoldenDataset } from './dataset.ts';
import { decodeTranscript, encodeTranscript } from './transcript.ts';
import type { Transcript } from './transcript.ts';

export type EvalFiles = {
  readText(file: string): Promise<string>;
  writeText(file: string, text: string): Promise<void>;
  listFiles(directory: string): Promise<string[]>;
};

const TRANSCRIPT_FILE_SUFFIX = '.transcript.jsonl';
const TRANSCRIPT_FILE_MODE = 0o600;

export const nodeEvalFiles: EvalFiles = {
  readText: (file) => fs.readFile(file, 'utf8'),
  writeText: (file, text) => fs.writeFile(file, text, { mode: TRANSCRIPT_FILE_MODE, flag: 'wx' }),
  listFiles: async (directory) => (await fs.readdir(directory)).sort().map((name) => path.join(directory, name)),
};

export const loadDataset = async (files: EvalFiles, file: string): Promise<GoldenDataset> => parseDataset(await files.readText(file), file);

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
