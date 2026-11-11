import { createHash } from 'node:crypto';
import path from 'node:path';
import { OPEN_FLAGS, sha256Hex, writeFileAtomically as writeFileAtomicallyThroughLock } from '@momonga/foundation';
import type { AtomicWriteFileSystem, FileSystem, Random } from '@momonga/foundation';
import type { ToolSessionState } from '../types.ts';
import { ToolExecutionError } from '../types.ts';
import { shownPath } from './paths.ts';
import type { PathScope } from './paths.ts';

export type FileStat = Awaited<ReturnType<FileSystem['stat']>>;

const BINARY_SNIFF_BYTES = 8192;
const FILE_READ_PAGE_BYTES = 64 * 1024;

export const isMissing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT';

export const statIfExists = async (files: Pick<FileSystem, 'stat'>, file: string): Promise<FileStat | undefined> => {
  try {
    return await files.stat(file);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
};

export const looksBinary = async (files: Pick<FileSystem, 'readStart'>, file: string): Promise<boolean> => (await files.readStart(file, BINARY_SNIFF_BYTES)).includes(0);

type PagedFiles = Pick<FileSystem, 'openRead'>;

async function* pagesOf(files: PagedFiles, file: string): AsyncGenerator<Buffer> {
  const handle = await files.openRead(file, OPEN_FLAGS.readOnly);
  try {
    const page = Buffer.alloc(FILE_READ_PAGE_BYTES);
    for (let bytesRead = await handle.read(page); bytesRead > 0; bytesRead = await handle.read(page)) yield page.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

export class NotUtf8Error extends Error {
  constructor() {
    super('the file is not UTF-8 text');
    this.name = 'NotUtf8Error';
  }
}

type Utf8Decoder = { write(bytes: Uint8Array): string; end(): string };

const utf8Decoder = (): Utf8Decoder => {
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  const decode = (bytes: Uint8Array | undefined): string => {
    try {
      return bytes === undefined ? decoder.decode() : decoder.decode(bytes, { stream: true });
    } catch (error) {
      if (error instanceof TypeError) throw new NotUtf8Error();
      throw error;
    }
  };
  return { write: (bytes) => decode(bytes), end: () => decode(undefined) };
};

export const isUtf8File = async (files: PagedFiles, file: string): Promise<boolean> => {
  const decoder = utf8Decoder();
  try {
    for await (const page of pagesOf(files, file)) decoder.write(page);
    decoder.end();
    return true;
  } catch (error) {
    if (error instanceof NotUtf8Error) return false;
    throw error;
  }
};

export const readUtf8File = async (files: Pick<FileSystem, 'readFile'>, file: string): Promise<string> => {
  const decoder = utf8Decoder();
  return decoder.write(await files.readFile(file)) + decoder.end();
};

export const sha256OfFile = async (files: PagedFiles, file: string): Promise<string> => {
  const hash = createHash('sha256');
  for await (const page of pagesOf(files, file)) hash.update(page);
  return hash.digest('hex');
};

export type LineScan = { sha256: string; totalLines: number };

export const scanLines = async (
  files: PagedFiles,
  file: string,
  onLine: (line: string, lineNumber: number) => void,
  signal: AbortSignal,
): Promise<LineScan> => {
  const hash = createHash('sha256');
  const decoder = utf8Decoder();
  let pending = '';
  let lineNumber = 0;
  const feed = (text: string): void => {
    pending += text;
    let start = 0;
    for (let newline = pending.indexOf('\n', start); newline !== -1; newline = pending.indexOf('\n', start)) {
      lineNumber += 1;
      const line = pending.slice(start, newline);
      onLine(line.endsWith('\r') ? line.slice(0, -1) : line, lineNumber);
      start = newline + 1;
    }
    pending = pending.slice(start);
  };
  for await (const page of pagesOf(files, file)) {
    signal.throwIfAborted();
    hash.update(page);
    feed(decoder.write(page));
  }
  feed(decoder.end());
  if (pending !== '') {
    lineNumber += 1;
    onLine(pending.endsWith('\r') ? pending.slice(0, -1) : pending, lineNumber);
  }
  return { sha256: hash.digest('hex'), totalLines: lineNumber };
};

export type AtomicWrite = {
  files: FileSystem;
  random: Random;
  scope: PathScope;
  target: string;
  requestedPath: string;
  content: string;
  mode: number;
  onRenamed(): Promise<string | undefined>;
};

export const regularFileProblem = (stat: FileStat, displayPath: string): string | undefined =>
  stat.isFile() ? undefined : `${displayPath} is not a regular file`;

const describeFailure = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export const updateLedgerAfterWrite = async (files: Pick<FileSystem, 'stat'>, session: ToolSessionState, canonical: string, sha256: string): Promise<string | undefined> => {
  try {
    await recordInLedger(files, session, canonical, sha256);
    return undefined;
  } catch (error) {
    session.readLedger.delete(canonical);
    return `Warning: the change was written but the read ledger could not be updated (${describeFailure(error)}); Read the file before editing it again.`;
  }
};

const differentLocation = async (scope: PathScope, requestedPath: string, expected: string, actual: string): Promise<ToolExecutionError> =>
  new ToolExecutionError(
    `${await shownPath(scope, requestedPath)} resolves to a different location than when it was approved (${await shownPath(scope, expected)} → ${await shownPath(scope, actual)}); retry the call`,
  );

const assertResolvesTo = async (files: Pick<FileSystem, 'realpath'>, scope: PathScope, requestedPath: string, directory: string): Promise<void> => {
  const resolved = await files.realpath(directory);
  if (resolved !== directory) throw await differentLocation(scope, requestedPath, directory, resolved);
};

const createMissingDirectories = async (files: FileSystem, scope: PathScope, directory: string, requestedPath: string): Promise<void> => {
  const missing: string[] = [];
  for (let current = directory; (await statIfExists(files, current)) === undefined; current = path.dirname(current)) missing.push(current);
  for (const level of missing.reverse()) {
    await files.makeDirectory(level);
    try {
      await assertResolvesTo(files, scope, requestedPath, level);
    } catch (error) {
      await files.removeEmptyDirectory(level).catch((removeError: unknown) => {
        const code = (removeError as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT' && code !== 'ENOTEMPTY' && code !== 'ENOTDIR') throw removeError;
      });
      throw error;
    }
  }
};

const recordingDirectorySync = (files: FileSystem, directory: string, failures: unknown[]): AtomicWriteFileSystem => ({
  ...files,
  open: async (file, flags, mode) => {
    const handle = await files.open(file, flags, mode);
    if (file !== directory) return handle;
    return {
      ...handle,
      sync: async () => {
        try {
          await handle.sync();
        } catch (error) {
          failures.push(error);
        }
      },
    };
  },
});

export const writeFileAtomically = async (write: AtomicWrite): Promise<string | undefined> => {
  const { files, target, content, mode } = write;
  const directory = path.dirname(target);
  await createMissingDirectories(files, write.scope, directory, write.requestedPath);
  await assertResolvesTo(files, write.scope, write.requestedPath, directory);
  const directorySyncFailures: unknown[] = [];
  let ledgerWarning: string | undefined;
  await writeFileAtomicallyThroughLock(recordingDirectorySync(files, directory, directorySyncFailures), write.random, target, content, {
    mode,
    beforePublish: () => assertResolvesTo(files, write.scope, write.requestedPath, directory),
    afterPublish: async () => {
      ledgerWarning = await write.onRenamed();
    },
  });
  if (directorySyncFailures.length === 0) return ledgerWarning;
  const syncWarning = `Warning: the change was written but the directory could not be synced (${describeFailure(directorySyncFailures[0])}).`;
  return ledgerWarning === undefined ? syncWarning : `${ledgerWarning}\n${syncWarning}`;
};

export const assertSameLocation = async (scope: PathScope, requestedPath: string, approvedPath: string, currentPath: string): Promise<void> => {
  if (currentPath !== approvedPath) throw await differentLocation(scope, requestedPath, approvedPath, currentPath);
};

export const newFileMode = (): number => 0o666 & ~process.umask();

export const recordInLedger = async (files: Pick<FileSystem, 'stat'>, session: ToolSessionState, canonical: string, sha256: string): Promise<void> => {
  const stat = await files.stat(canonical);
  session.readLedger.set(canonical, { sha256, mtimeMs: stat.mtimeMs });
};

export const assertReadAndUnchanged = async (files: PagedFiles, session: ToolSessionState, canonical: string, shown: string): Promise<string> => {
  const entry = session.readLedger.get(canonical);
  if (entry === undefined) {
    throw new ToolExecutionError(`${shown} has not been read in this session; Read it first before modifying it`);
  }
  const current = await sha256OfFile(files, canonical);
  if (current !== entry.sha256) {
    throw new ToolExecutionError(`${shown} has changed since it was last read; Read it again before modifying it`);
  }
  return current;
};

export const hashOfFileIfExists = async (files: Pick<FileSystem, 'readFile'>, file: string): Promise<string | null> => {
  try {
    return sha256Hex(await files.readFile(file));
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
};
