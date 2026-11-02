import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { COMMON_ENTRY_FLAGS, runDaemonEntry } from '@momonga/foundation';
import type { DaemonDefinition, DaemonHandle, DaemonStartContext, RotatingLogFile } from '@momonga/foundation';
import { createFakeEntryIo, parseJsonLines, waitFor } from '@momonga/testkit';

const HOME = '/Users/alice';
const LOG_PATH = path.join(HOME, '.momonga', 'logs', 'runtime.log');
const ARGV = [`--home=${HOME}`, '--log-target=file'];

type Flags = typeof COMMON_ENTRY_FLAGS;

const closingDaemon = () => {
  const contexts: Array<DaemonStartContext<Flags>> = [];
  const handle: DaemonHandle = {
    close: () => Promise.resolve({ clean: true }),
    abort: () => Promise.resolve({ clean: true }),
    fatal: new Promise<Error>(() => undefined),
  };
  const definition: DaemonDefinition<Flags> = {
    service: 'runtime',
    version: '1.0.0',
    flags: COMMON_ENTRY_FLAGS,
    maxCloseMs: () => 1000,
    ownLockPath: (home) => path.join(home, '.momonga', 'run', 'runtime.lock'),
    logPath: (home) => path.join(home, '.momonga', 'logs', 'runtime.log'),
    isConfigError: () => false,
    start: (context) => {
      contexts.push(context);
      return Promise.resolve(handle);
    },
  };
  return { definition, contexts };
};

describe('createFakeEntryIo options', () => {
  it('a custom logFile receives the path and the engine lines, and the path is recorded', async () => {
    const opened: string[] = [];
    const written: string[] = [];
    const logFile = (file: string): RotatingLogFile => {
      opened.push(file);
      return { write: (line) => void written.push(line), close: () => undefined, droppedLines: 0 };
    };
    const io = createFakeEntryIo({ argv: ARGV, home: HOME, logFile });
    const daemon = closingDaemon();
    const running = runDaemonEntry(io, daemon.definition);
    await waitFor(() => daemon.contexts.length === 1, { description: 'start called' });
    io.signal('SIGTERM');
    expect(await running).toBe(0);
    expect(opened).toEqual([LOG_PATH]);
    expect(io.logFilePaths).toEqual([LOG_PATH]);
    const messages = parseJsonLines(written.join('').split('\n').filter((line) => line !== '')).map((line) => line.msg);
    expect(messages[0]).toBe('entry.start');
    expect(messages.at(-1)).toBe('entry.exit');
  });

  it('setDroppedLines is visible through the droppedLogLines handed to start', async () => {
    const io = createFakeEntryIo({ argv: ARGV, home: HOME });
    const daemon = closingDaemon();
    const running = runDaemonEntry(io, daemon.definition);
    await waitFor(() => daemon.contexts.length === 1, { description: 'start called' });
    const context = daemon.contexts[0];
    expect(context?.droppedLogLines()).toBe(0);
    io.setDroppedLines(LOG_PATH, 7);
    expect(context?.droppedLogLines()).toBe(7);
    io.setDroppedLines(LOG_PATH, 12);
    expect(context?.droppedLogLines()).toBe(12);
    io.signal('SIGTERM');
    expect(await running).toBe(0);
  });

  it('with neither option the default in-memory sink behaves as before', async () => {
    const io = createFakeEntryIo({ argv: ARGV, home: HOME });
    const daemon = closingDaemon();
    const running = runDaemonEntry(io, daemon.definition);
    await waitFor(() => daemon.contexts.length === 1, { description: 'start called' });
    expect(daemon.contexts[0]?.droppedLogLines()).toBe(0);
    io.signal('SIGTERM');
    expect(await running).toBe(0);
    expect(io.logFilePaths).toEqual([LOG_PATH]);
    const messages = parseJsonLines(io.logLines(LOG_PATH)).map((line) => line.msg);
    expect(messages[0]).toBe('entry.start');
    expect(messages.at(-1)).toBe('entry.exit');
    expect(io.exits).toEqual([0]);
  });
});
