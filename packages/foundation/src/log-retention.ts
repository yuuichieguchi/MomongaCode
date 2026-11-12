import { rotatedLogPath } from './momonga-paths.ts';
import type { FileSystem } from './node-file-system.ts';
import { LOG_KEEP } from './rotating-log.ts';

export type LogRetentionFiles = Pick<FileSystem, 'stat' | 'rm'>;

const isMissing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT';

const removeWhenOlder = async (files: LogRetentionFiles, file: string, cutoffMs: number): Promise<void> => {
  let modifiedMs: number;
  try {
    modifiedMs = (await files.stat(file)).mtimeMs;
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  if (modifiedMs < cutoffMs) await files.rm(file);
};

export const rotatedLogsPurge =
  (files: LogRetentionFiles, logFiles: readonly string[]) =>
  async (_runIds: readonly string[], cutoffMs: number, signal: AbortSignal): Promise<void> => {
    for (const logFile of logFiles) {
      for (let generation = 1; generation <= LOG_KEEP; generation += 1) {
        signal.throwIfAborted();
        await removeWhenOlder(files, rotatedLogPath(logFile, generation), cutoffMs);
      }
    }
  };
