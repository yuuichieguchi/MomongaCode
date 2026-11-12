import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { COMMON_ENTRY_FLAGS, DEFAULT_STOP_VALUES, EXIT_FAILURE, LOG_KEEP, LOG_MAX_BYTES, createRotatingLogFile, runDaemonEntry } from '@momonga/foundation';
import type { DaemonDefinition, DaemonStartContext } from '@momonga/foundation';
import { createFakeEntryIo, parseJsonLines, withTempDir } from '@momonga/testkit';
import { LogDirectoryMissingError } from '../src/rotating-log.ts';

type Flags = typeof COMMON_ENTRY_FLAGS;

describe('a log writer never creates the directory that holds its files', () => {
  it('refuses a log file in a missing directory with a typed error and creates no directory', (context) => {
    const home = withTempDir(context);
    const directory = path.join(home, 'removed-home', 'logs');
    const failure = (() => {
      try {
        createRotatingLogFile({ path: path.join(directory, 'runtime.log'), maxBytes: LOG_MAX_BYTES, keep: LOG_KEEP });
        return undefined;
      } catch (error) {
        return error;
      }
    })();
    expect(failure).toBeInstanceOf(LogDirectoryMissingError);
    expect((failure as LogDirectoryMissingError).directory).toBe(directory);
    expect(fs.existsSync(path.join(home, 'removed-home'))).toBe(false);
  });

  it('opens and writes a log file in a directory that exists', (context) => {
    const directory = withTempDir(context);
    const file = path.join(directory, 'runtime.log');
    const sink = createRotatingLogFile({ path: file, maxBytes: LOG_MAX_BYTES, keep: LOG_KEEP });
    sink.write('{"tag":"one"}\n');
    sink.close();
    expect(fs.readFileSync(file, 'utf8')).toBe('{"tag":"one"}\n');
  });

  it('stops a daemon whose log directory is missing with the error on stderr, before it starts', async (context) => {
    const home = withTempDir(context);
    const contexts: Array<DaemonStartContext<Flags>> = [];
    const definition: DaemonDefinition<Flags> = {
      service: 'runtime',
      version: '1.0.0',
      flags: COMMON_ENTRY_FLAGS,
      maxCloseMs: () => 1000,
      readStopValues: () => DEFAULT_STOP_VALUES,
      ownLockPath: (resolvedHome) => path.join(resolvedHome, '.momonga', 'run', 'runtime.lock'),
      logPath: (resolvedHome) => path.join(resolvedHome, '.momonga', 'logs', 'runtime.log'),
      isConfigError: () => false,
      start: (started) => {
        contexts.push(started);
        return Promise.reject(new Error('the daemon of this test never starts'));
      },
    };
    const io = createFakeEntryIo({
      argv: [`--home=${home}`, '--log-target=file'],
      home,
      logFile: (file) => {
        throw new LogDirectoryMissingError(path.dirname(file));
      },
    });
    expect(await runDaemonEntry(io, definition)).toBe(EXIT_FAILURE);
    expect(contexts).toEqual([]);
    const lines = parseJsonLines(io.stderrLines());
    expect(lines.map((line) => line.msg)).toEqual(['entry.log_directory_missing']);
    expect(JSON.stringify(lines[0])).toContain(path.join('.momonga', 'logs'));
  });
});
