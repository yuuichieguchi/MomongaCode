import fs from 'node:fs';
import path from 'node:path';

const CONTINUATION_MASK = 0b1100_0000;
const CONTINUATION_BITS = 0b1000_0000;
const JOB_OUTPUT_FILE_MODE = 0o600;
const JOB_OUTPUT_DIRECTORY_MODE = 0o700;
const JOB_OUTPUT_SUFFIX = '.out';

export type JobOutputFile = {
  readonly path: string;
  append(chunk: Buffer): void;
  failure(): string | undefined;
  close(): Promise<void>;
};

export type JobOutputFileOptions = { path: string; maxBytes: number; onFailure(code: string): void };

export type JobFileWindow = { start: number; total: number; bytes: Buffer };

const codeOf = (error: unknown): string => {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === 'string' ? code : error instanceof Error ? error.name : 'unknown';
};

export const jobOutputFileErrorCode = codeOf;

export const jobOutputPathOf = (jobsDirectory: string, jobId: string): string => path.join(jobsDirectory, `${jobId}${JOB_OUTPUT_SUFFIX}`);

export const ensureJobOutputDirectory = async (jobsDirectory: string): Promise<void> => {
  try {
    await fs.promises.mkdir(jobsDirectory, { mode: JOB_OUTPUT_DIRECTORY_MODE });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
};

export const openJobOutputFile = async ({ path: filePath, maxBytes, onFailure }: JobOutputFileOptions): Promise<JobOutputFile> => {
  const { O_WRONLY, O_CREAT, O_EXCL, O_APPEND, O_NOFOLLOW } = fs.constants;
  const handle = await fs.promises.open(filePath, O_WRONLY | O_CREAT | O_EXCL | O_APPEND | O_NOFOLLOW, JOB_OUTPUT_FILE_MODE);
  let written = 0;
  let failed: string | undefined;
  let queue: Promise<void> = Promise.resolve();
  const write = async (chunk: Buffer): Promise<void> => {
    if (failed !== undefined || written >= maxBytes) return;
    const kept = chunk.length <= maxBytes - written ? chunk : chunk.subarray(0, maxBytes - written);
    try {
      await handle.write(kept);
      written += kept.length;
    } catch (error) {
      failed = codeOf(error);
      onFailure(failed);
    }
  };
  return {
    path: filePath,
    append: (chunk) => {
      queue = queue.then(() => write(chunk));
    },
    failure: () => failed,
    close: async () => {
      await queue;
      await handle.close();
    },
  };
};

export const removeJobOutputFile = async (filePath: string): Promise<void> => {
  await fs.promises.rm(filePath, { force: true });
};

const isContinuation = (byte: number | undefined): boolean => byte !== undefined && (byte & CONTINUATION_MASK) === CONTINUATION_BITS;

export const readJobFileWindow = async (filePath: string, from: number, windowBytes: number): Promise<JobFileWindow | undefined> => {
  let handle: fs.promises.FileHandle;
  try {
    handle = await fs.promises.open(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  try {
    const total = (await handle.stat()).size;
    let start = Math.max(0, total - windowBytes);
    const begin = Math.max(from, start);
    const length = Math.max(0, total - begin);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = length === 0 ? { bytesRead: 0 } : await handle.read(buffer, 0, length, begin);
    let bytes = buffer.subarray(0, bytesRead);
    if (begin === start && start > 0) {
      while (isContinuation(bytes[0])) {
        bytes = bytes.subarray(1);
        start += 1;
      }
    }
    return { start, total: begin + bytesRead, bytes };
  } finally {
    await handle.close();
  }
};
