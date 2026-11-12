import fs from 'node:fs';
import path from 'node:path';
import { rotatedLogPath } from './momonga-paths.ts';

export const LOG_MAX_BYTES = 10 * 1024 * 1024;
export const LOG_KEEP = 4;

export type RotatingLogFile = {
  write(line: string): void;
  close(): void;
  readonly droppedLines: number;
};

export type RotatingLogFileOptions = {
  path: string;
  maxBytes: number;
  keep: number;
  mode?: number;
  writeSync?: typeof fs.writeSync;
  onWriteFailure?: (error: Error) => void;
};

type FileIdentity = { dev: bigint; ino: bigint };

const toError = (error: unknown): Error => (error instanceof Error ? error : new Error(String(error)));

const errorCode = (error: unknown): string | undefined => (error as NodeJS.ErrnoException).code;

const identityOf = (stat: fs.BigIntStats): FileIdentity => ({ dev: stat.dev, ino: stat.ino });

const sameIdentity = (left: FileIdentity, right: FileIdentity): boolean => left.dev === right.dev && left.ino === right.ino;

export class LogDirectoryMissingError extends Error {
  readonly directory: string;

  constructor(directory: string) {
    super(`the log directory ${directory} does not exist; the log never creates it, because a removed home stays removed`);
    this.name = 'LogDirectoryMissingError';
    this.directory = directory;
  }
}

export const createRotatingLogFile = (options: RotatingLogFileOptions): RotatingLogFile => {
  const { path: file, maxBytes, keep, mode = 0o600, writeSync = fs.writeSync, onWriteFailure } = options;
  const flags = fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT;
  let fd: number | undefined;
  let identity: FileIdentity;
  let dropped = 0;
  let closed = false;

  const openCurrent = (): void => {
    const opened = fs.openSync(file, flags, mode);
    fd = opened;
    identity = identityOf(fs.fstatSync(opened, { bigint: true }));
  };

  const closeCurrent = (): void => {
    if (fd === undefined) return;
    const closing = fd;
    fd = undefined;
    fs.closeSync(closing);
  };

  const openFd = (): number => {
    if (fd === undefined) throw new Error(`log file ${file} is not open`);
    return fd;
  };

  const report = (error: unknown): void => {
    onWriteFailure?.(toError(error));
  };

  const statCurrent = (): fs.BigIntStats | undefined => {
    try {
      return fs.statSync(file, { bigint: true });
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return undefined;
      throw error;
    }
  };

  const rotate = (): void => {
    for (let generation = keep - 1; generation >= 1; generation -= 1) {
      try {
        fs.renameSync(rotatedLogPath(file, generation), rotatedLogPath(file, generation + 1));
      } catch (error) {
        if (errorCode(error) !== 'ENOENT') throw error;
      }
    }
    fs.renameSync(file, rotatedLogPath(file, 1));
    closeCurrent();
    openCurrent();
  };

  const prepare = (bytes: number): void => {
    let stat: fs.BigIntStats | undefined;
    try {
      stat = statCurrent();
    } catch (error) {
      report(error);
      return;
    }
    if (stat === undefined || !sameIdentity(identityOf(stat), identity)) {
      closeCurrent();
      openCurrent();
      try {
        stat = statCurrent();
      } catch (error) {
        report(error);
        return;
      }
      if (stat === undefined || !sameIdentity(identityOf(stat), identity)) return;
    }
    if (stat.size > 0n && Number(stat.size) + bytes > maxBytes) {
      try {
        rotate();
      } catch (error) {
        report(error);
        if (fd === undefined) openCurrent();
      }
    }
  };

  const writeAll = (currentFd: number, data: Buffer): void => {
    let offset = 0;
    while (offset < data.length) offset += writeSync(currentFd, data, offset, data.length - offset);
  };

  try {
    openCurrent();
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') throw new LogDirectoryMissingError(path.dirname(file));
    throw error;
  }

  return {
    write: (line) => {
      if (closed) {
        dropped += 1;
        return;
      }
      const data = Buffer.from(line.endsWith('\n') ? line : `${line}\n`, 'utf8');
      try {
        if (fd === undefined) openCurrent();
        prepare(data.length);
        writeAll(openFd(), data);
      } catch (error) {
        dropped += 1;
        report(error);
      }
    },
    close: () => {
      closed = true;
      try {
        closeCurrent();
      } catch (error) {
        report(error);
      }
    },
    get droppedLines() {
      return dropped;
    },
  };
};
