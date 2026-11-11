import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { COMMON_ENTRY_FLAGS, DEFAULT_STOP_VALUES, EXIT_CONFIG, EXIT_FAILURE, createPathResolver, hostPaths, runDaemonEntry } from '@momonga/foundation';
import type { DaemonDefinition, DaemonStartContext, PathResolver } from '@momonga/foundation';
import { createFakeEntryIo, parseJsonLines, withTempDir } from '@momonga/testkit';

type Flags = typeof COMMON_ENTRY_FLAGS;

const errno = (code: string, target: string): Error => Object.assign(new Error(`${code}: the host failed, lstat '${target}'`), { code, syscall: 'lstat', path: target });

const failingWith = (code: string) => (signal: AbortSignal): PathResolver => {
  const fail = (target: string): Promise<never> => Promise.reject(errno(code, target));
  return createPathResolver({ stat: fail, lstat: fail, readlink: fail, realpath: fail, openDirectory: fail, access: fail }, signal);
};

const neverStarted = (overrides: Partial<DaemonDefinition<Flags>> = {}): { definition: DaemonDefinition<Flags>; contexts: Array<DaemonStartContext<Flags>> } => {
  const contexts: Array<DaemonStartContext<Flags>> = [];
  return {
    contexts,
    definition: {
      service: 'runtime',
      version: '1.0.0',
      flags: COMMON_ENTRY_FLAGS,
      maxCloseMs: () => 1000,
      readStopValues: () => DEFAULT_STOP_VALUES,
      ownLockPath: (home) => path.join(home, '.momonga', 'run', 'runtime.lock'),
      logPath: (home) => path.join(home, '.momonga', 'logs', 'runtime.log'),
      isConfigError: () => false,
      start: (context) => {
        contexts.push(context);
        return Promise.reject(new Error('the daemon of this test never starts'));
      },
      ...overrides,
    },
  };
};

describe('a daemon resolves its home through the asynchronous file-system port', () => {
  it('a home whose resolution fails on the host exits as a failure with one stderr line that names the home and the code, before any log file opens', async () => {
    const home = '/homes/of/a/failing/disk';
    const io = createFakeEntryIo({ argv: [`--home=${home}`, '--log-target=file'], home, paths: failingWith('EIO') });
    const daemon = neverStarted();
    expect(await runDaemonEntry(io, daemon.definition)).toBe(EXIT_FAILURE);
    expect(io.exits).toEqual([EXIT_FAILURE]);
    expect(io.logFilePaths).toEqual([]);
    expect(daemon.contexts).toEqual([]);
    const lines = parseJsonLines(io.stderrLines());
    expect(lines.map((line) => line.msg)).toEqual(['entry.home_unresolved']);
    expect(lines[0]).toMatchObject({ level: 'error', err: { name: 'HomeUnresolvedError' }, home, code: 'EIO' });
    expect(JSON.stringify(lines[0])).toContain(`the home ${home} cannot be resolved (EIO)`);
  });

  it('a home that names no resolvable path is a usage error whose line names the home and the code', async () => {
    const home = '/homes/through/a/loop';
    const io = createFakeEntryIo({ argv: [`--home=${home}`, '--log-target=file'], home, paths: failingWith('ELOOP') });
    expect(await runDaemonEntry(io, neverStarted().definition)).toBe(EXIT_CONFIG);
    const lines = parseJsonLines(io.stderrLines());
    expect(lines.map((line) => line.msg)).toEqual(['entry.usage_error']);
    expect(JSON.stringify(lines[0])).toContain(`the home ${home} cannot be resolved (ELOOP)`);
    expect(io.logFilePaths).toEqual([]);
  });

  it('opens the log file after the home is resolved, under the resolved home', async (context) => {
    const home = withTempDir(context);
    const events: string[] = [];
    const paths = (signal: AbortSignal): PathResolver => {
      const host = hostPaths(signal);
      return {
        ...host,
        canonicalPath: async (target) => {
          const resolved = await host.canonicalPath(target);
          events.push(`resolved ${target}`);
          return resolved;
        },
      };
    };
    const io = createFakeEntryIo({
      argv: [`--home=${home}`, '--log-target=file'],
      home,
      paths,
      logFile: (file) => {
        events.push(`opened ${path.basename(file)}`);
        return { write: () => undefined, close: () => undefined, droppedLines: 0 };
      },
    });
    await runDaemonEntry(io, neverStarted().definition);
    expect(events).toEqual([`resolved ${home}`, 'opened runtime.log']);
  });
});
