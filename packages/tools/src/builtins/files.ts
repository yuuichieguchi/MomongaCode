import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { nodeFileSystem, sha256Hex, systemRandom, writeFileAtomically as writeFileAtomicallyThroughLock } from '@momonga/foundation';
import type { AtomicWriteFileSystem } from '@momonga/foundation';
import type { ToolSessionState } from '../types.ts';
import { ToolExecutionError } from '../types.ts';
import { shownPath } from './paths.ts';
import type { PathScope } from './paths.ts';

const BINARY_SNIFF_BYTES = 8192;

export const isMissing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT';

export const statIfExists = async (file: string): Promise<fs.Stats | undefined> => {
  try {
    return await fs.promises.stat(file);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
};

export const looksBinary = async (file: string): Promise<boolean> => {
  const handle = await fs.promises.open(file, 'r');
  try {
    const buffer = Buffer.alloc(BINARY_SNIFF_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, BINARY_SNIFF_BYTES, 0);
    return buffer.subarray(0, bytesRead).includes(0);
  } finally {
    await handle.close();
  }
};

export const sha256OfFile = async (file: string): Promise<string> => {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
};

export type LineScan = { sha256: string; totalLines: number };

export const scanLines = async (
  file: string,
  onLine: (line: string, lineNumber: number) => void,
  signal: AbortSignal,
): Promise<LineScan> => {
  const hash = createHash('sha256');
  const decoder = new StringDecoder('utf8');
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
  for await (const chunk of fs.createReadStream(file)) {
    signal.throwIfAborted();
    hash.update(chunk as Buffer);
    feed(decoder.write(chunk as Buffer));
  }
  feed(decoder.end());
  if (pending !== '') {
    lineNumber += 1;
    onLine(pending.endsWith('\r') ? pending.slice(0, -1) : pending, lineNumber);
  }
  return { sha256: hash.digest('hex'), totalLines: lineNumber };
};

export type AtomicWrite = {
  scope: PathScope;
  target: string;
  requestedPath: string;
  content: string;
  mode: number;
  onRenamed(): Promise<string | undefined>;
};

export const regularFileProblem = (stat: fs.Stats, displayPath: string): string | undefined =>
  stat.isFile() ? undefined : `${displayPath} is not a regular file`;

const describeFailure = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export const updateLedgerAfterWrite = async (session: ToolSessionState, canonical: string, sha256: string): Promise<string | undefined> => {
  try {
    await recordInLedger(session, canonical, sha256);
    return undefined;
  } catch (error) {
    session.readLedger.delete(canonical);
    return `Warning: the change was written but the read ledger could not be updated (${describeFailure(error)}); Read the file before editing it again.`;
  }
};

const differentLocation = (scope: PathScope, requestedPath: string, expected: string, actual: string): ToolExecutionError =>
  new ToolExecutionError(
    `${shownPath(scope, requestedPath)} resolves to a different location than when it was approved (${shownPath(scope, expected)} → ${shownPath(scope, actual)}); retry the call`,
  );

const assertResolvesTo = async (scope: PathScope, requestedPath: string, directory: string): Promise<void> => {
  const resolved = await fs.promises.realpath(directory);
  if (resolved !== directory) throw differentLocation(scope, requestedPath, directory, resolved);
};

const createMissingDirectories = async (scope: PathScope, directory: string, requestedPath: string): Promise<void> => {
  const missing: string[] = [];
  for (let current = directory; (await statIfExists(current)) === undefined; current = path.dirname(current)) missing.push(current);
  for (const level of missing.reverse()) {
    await fs.promises.mkdir(level);
    try {
      await assertResolvesTo(scope, requestedPath, level);
    } catch (error) {
      await fs.promises.rmdir(level).catch((removeError: unknown) => {
        const code = (removeError as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT' && code !== 'ENOTEMPTY' && code !== 'ENOTDIR') throw removeError;
      });
      throw error;
    }
  }
};

const recordingDirectorySync = (directory: string, failures: unknown[]): AtomicWriteFileSystem => ({
  ...nodeFileSystem,
  open: async (file, flags, mode) => {
    const handle = await nodeFileSystem.open(file, flags, mode);
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
  const { target, content, mode } = write;
  const directory = path.dirname(target);
  await createMissingDirectories(write.scope, directory, write.requestedPath);
  await assertResolvesTo(write.scope, write.requestedPath, directory);
  const directorySyncFailures: unknown[] = [];
  let ledgerWarning: string | undefined;
  await writeFileAtomicallyThroughLock(recordingDirectorySync(directory, directorySyncFailures), systemRandom, target, content, {
    mode,
    beforePublish: () => assertResolvesTo(write.scope, write.requestedPath, directory),
    afterPublish: async () => {
      ledgerWarning = await write.onRenamed();
    },
  });
  if (directorySyncFailures.length === 0) return ledgerWarning;
  const syncWarning = `Warning: the change was written but the directory could not be synced (${describeFailure(directorySyncFailures[0])}).`;
  return ledgerWarning === undefined ? syncWarning : `${ledgerWarning}\n${syncWarning}`;
};

export const assertSameLocation = (scope: PathScope, requestedPath: string, approvedPath: string, currentPath: string): void => {
  if (currentPath !== approvedPath) throw differentLocation(scope, requestedPath, approvedPath, currentPath);
};

export const newFileMode = (): number => 0o666 & ~process.umask();

export const recordInLedger = async (session: ToolSessionState, canonical: string, sha256: string): Promise<void> => {
  const stat = await fs.promises.stat(canonical);
  session.readLedger.set(canonical, { sha256, mtimeMs: stat.mtimeMs });
};

export const assertReadAndUnchanged = async (session: ToolSessionState, canonical: string, shown: string): Promise<string> => {
  const entry = session.readLedger.get(canonical);
  if (entry === undefined) {
    throw new ToolExecutionError(`${shown} has not been read in this session; Read it first before modifying it`);
  }
  const current = await sha256OfFile(canonical);
  if (current !== entry.sha256) {
    throw new ToolExecutionError(`${shown} has changed since it was last read; Read it again before modifying it`);
  }
  return current;
};

export const hashOfFileIfExists = async (file: string): Promise<string | null> => {
  try {
    return sha256Hex(await fs.promises.readFile(file));
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
};
