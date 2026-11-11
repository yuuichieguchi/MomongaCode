import { EventEmitter } from 'node:events';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { COMMON_ENTRY_FLAGS, DEFAULT_STOP_VALUES, nodeEntryIo, runDaemonEntry, hostPaths } from '@momonga/foundation';
import type { DaemonCloseResult, DaemonDefinition, DaemonHandle, EntryIo, EntrySignal, RotatingLogFile } from '@momonga/foundation';
import { createFakeClock, createFakeTimers } from '@momonga/testkit';

const HOME = '/Users/alice';
const LOG_PATH = path.join(HOME, '.momonga', 'logs', 'runtime.log');
const MAX_CLOSE_MS = 1000;
const START_MS = 1_800_000_000_000;

type Flags = typeof COMMON_ENTRY_FLAGS;

const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 10; turn += 1) await new Promise((resolve) => setImmediate(resolve));
};

type LogLine = Record<string, unknown> & { msg: string };

const parseLines = (chunks: readonly string[]): LogLine[] =>
  chunks
    .join('')
    .split('\n')
    .filter((entry) => entry !== '')
    .map((entry) => JSON.parse(entry) as LogLine);

type Deferred<T> = { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void };
const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  promise.catch(() => undefined);
  return { promise, resolve, reject };
};

const fakeIo = (argv: readonly string[]) => {
  const clock = createFakeClock(START_MS);
  const timers = createFakeTimers(clock);
  const lifecycle: string[] = [];
  const signalHandlers = new Map<EntrySignal, Array<() => void>>();
  const uncaughtHandlers: Array<(error: Error) => void> = [];
  const lifelines: Array<{ onEnd: () => void }> = [];
  const sinkChunks: string[] = [];
  const stderrChunks: string[] = [];
  const stdoutChunks: string[] = [];
  const exits: number[] = [];
  const io: EntryIo = {
    argv,
    env: { HOME },
    home: HOME,
    paths: hostPaths,
    stdout: { write: (chunk) => (stdoutChunks.push(chunk), true) },
    stderr: { write: (chunk) => (stderrChunks.push(chunk), true) },
    clock,
    timers,
    onSignal: (signal, handler) => {
      const list = signalHandlers.get(signal) ?? [];
      list.push(handler);
      signalHandlers.set(signal, list);
      return () => {
        lifecycle.push(`dispose:${signal}`);
        const current = signalHandlers.get(signal) ?? [];
        signalHandlers.set(signal, current.filter((entry) => entry !== handler));
      };
    },
    onUncaught: (handler) => {
      uncaughtHandlers.push(handler);
      return () => {
        lifecycle.push('dispose:uncaught');
        const index = uncaughtHandlers.indexOf(handler);
        if (index !== -1) uncaughtHandlers.splice(index, 1);
      };
    },
    watchLifeline: (_fd, handlers) => {
      lifelines.push({ onEnd: handlers.onEnd });
      return { dispose: () => void lifecycle.push('dispose:lifeline'), drain: async () => undefined };
    },
    logFile: () => {
      const sink: RotatingLogFile = {
        write: (entry) => void sinkChunks.push(entry.endsWith('\n') ? entry : `${entry}\n`),
        close: () => undefined,
        droppedLines: 0,
      };
      return sink;
    },
    holdOpen: () => {
      lifecycle.push('hold');
      return () => lifecycle.push('release');
    },
    exit: (code) => {
      lifecycle.push(`exit:${code}`);
      exits.push(code);
    },
  };
  return {
    io,
    timers,
    exits,
    lifecycle,
    sinkLines: () => parseLines(sinkChunks),
    stderrLines: () => parseLines(stderrChunks),
    stdout: () => stdoutChunks.join(''),
    signal: (name: EntrySignal) => {
      for (const handler of [...(signalHandlers.get(name) ?? [])]) handler();
    },
    uncaught: (error: Error) => {
      for (const handler of [...uncaughtHandlers]) handler(error);
    },
    eof: () => {
      for (const lifeline of lifelines) lifeline.onEnd();
    },
  };
};

const scriptedDaemon = (overrides: Partial<DaemonDefinition<Flags>> = {}) => {
  const start = deferred<DaemonHandle>();
  const result = deferred<DaemonCloseResult>();
  const fatal = deferred<Error>();
  const close = vi.fn(() => result.promise);
  const abort = vi.fn(() => result.promise);
  const handle: DaemonHandle = { close, abort, fatal: fatal.promise };
  const definition: DaemonDefinition<Flags> = {
    service: 'runtime',
    version: '1.0.0',
    flags: COMMON_ENTRY_FLAGS,
    maxCloseMs: () => MAX_CLOSE_MS,
    readStopValues: () => DEFAULT_STOP_VALUES,
    ownLockPath: (home) => path.join(home, '.momonga', 'run', 'runtime.lock'),
    logPath: () => LOG_PATH,
    isConfigError: () => false,
    start: () => start.promise,
    ...overrides,
  };
  return { definition, start, result, fatal, handle, close, abort, run: () => start.resolve(handle) };
};

const ARGV_FILE = [`--home=${HOME}`, '--log-target=file'];

afterEach(() => {
  vi.useRealTimers();
});

describe('A1: lifecycle hold and disposal', () => {
  it('the engine takes exactly one hold and releases it before io.exit on a running SIGTERM close', async () => {
    const fake = fakeIo(ARGV_FILE);
    const daemon = scriptedDaemon();
    const running = runDaemonEntry(fake.io, daemon.definition);
    await settle();
    daemon.run();
    await settle();
    fake.signal('SIGTERM');
    daemon.result.resolve({ clean: true });
    expect(await running).toBe(0);
    const holds = fake.lifecycle.filter((event) => event === 'hold');
    const releases = fake.lifecycle.filter((event) => event === 'release');
    expect(holds).toHaveLength(1);
    expect(releases).toHaveLength(1);
    expect(fake.lifecycle.indexOf('release')).toBeLessThan(fake.lifecycle.indexOf('exit:0'));
  });

  it('the engine releases its hold on a usage-error exit (code 78 before start)', async () => {
    const fake = fakeIo(['--log-target=syslog', `--home=${HOME}`]);
    const daemon = scriptedDaemon();
    expect(await runDaemonEntry(fake.io, daemon.definition)).toBe(78);
    expect(fake.lifecycle.filter((event) => event === 'hold')).toHaveLength(1);
    expect(fake.lifecycle.filter((event) => event === 'release')).toHaveLength(1);
    expect(fake.lifecycle.indexOf('release')).toBeLessThan(fake.lifecycle.indexOf('exit:78'));
  });

  it('the engine releases its hold on a start-failed exit', async () => {
    const fake = fakeIo(ARGV_FILE);
    const daemon = scriptedDaemon();
    const running = runDaemonEntry(fake.io, daemon.definition);
    await settle();
    daemon.start.reject(new Error('boom'));
    expect(await running).toBe(1);
    expect(fake.lifecycle.filter((event) => event === 'release')).toHaveLength(1);
    expect(fake.lifecycle.indexOf('release')).toBeLessThan(fake.lifecycle.indexOf('exit:1'));
  });

  it('finish calls every disposer (onSignal x2, onUncaught, watchLifeline) before io.exit', async () => {
    const fake = fakeIo([...ARGV_FILE, '--lifeline-fd=3']);
    const daemon = scriptedDaemon();
    const running = runDaemonEntry(fake.io, daemon.definition);
    await settle();
    daemon.run();
    await settle();
    fake.signal('SIGTERM');
    daemon.result.resolve({ clean: true });
    expect(await running).toBe(0);
    const kinds = fake.lifecycle.filter((event) => event.startsWith('dispose:'));
    expect(kinds.filter((event) => event === 'dispose:SIGTERM')).toHaveLength(1);
    expect(kinds.filter((event) => event === 'dispose:SIGINT')).toHaveLength(1);
    expect(kinds.filter((event) => event === 'dispose:uncaught')).toHaveLength(1);
    expect(kinds.filter((event) => event === 'dispose:lifeline')).toHaveLength(1);
    for (const kind of kinds) {
      expect(fake.lifecycle.indexOf(kind)).toBeLessThan(fake.lifecycle.indexOf('exit:0'));
    }
  });
});

const fakeStream = () => {
  const emitter = new EventEmitter();
  const stream = Object.assign(emitter, {
    write: (_chunk: string, callback?: () => void): boolean => {
      if (callback !== undefined) setImmediate(callback);
      return true;
    },
  });
  return stream;
};

const fakeHost = (argv: readonly string[]) => {
  const stdout = fakeStream();
  const stderr = fakeStream();
  const exited = Promise.withResolvers<number>();
  const exit = vi.fn((code: number) => exited.resolve(code));
  const host = Object.assign(new EventEmitter(), {
    argv: ['/usr/bin/node', '/app/bin.ts', ...argv],
    env: { HOME: '/Users/host' } as Record<string, string | undefined>,
    stdout,
    stderr,
    exit,
    exitCode: undefined as number | undefined,
    pid: 4242,
  });
  return { host, stdout, stderr, exit, exited, asProcess: host as unknown as NodeJS.Process };
};

describe('A1(c): nodeEntryIo', () => {
  it('onSignal creates no timer', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const { asProcess } = fakeHost([]);
    const io = nodeEntryIo(asProcess);
    const before = vi.getTimerCount();
    const dispose = io.onSignal('SIGTERM', () => undefined);
    expect(vi.getTimerCount()).toBe(before);
    dispose();
    expect(vi.getTimerCount()).toBe(before);
  });

  it('holdOpen creates exactly one ref\'d handle and its release clears it', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const { asProcess } = fakeHost([]);
    const io = nodeEntryIo(asProcess);
    const before = vi.getTimerCount();
    const release = io.holdOpen();
    expect(vi.getTimerCount()).toBe(before + 1);
    release();
    expect(vi.getTimerCount()).toBe(before);
  });

  it('a full entry run leaves no pending timer and listener counts return to baseline', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const { host, asProcess, exit, exited } = fakeHost(['--log-target=stderr']);
    const io = nodeEntryIo(asProcess);
    const baselineTimers = vi.getTimerCount();
    const baselineSigterm = host.listenerCount('SIGTERM');
    const baselineSigint = host.listenerCount('SIGINT');
    const baselineUncaught = host.listenerCount('uncaughtException');
    const baselineRejection = host.listenerCount('unhandledRejection');
    const daemon = scriptedDaemon();
    const running = runDaemonEntry(io, daemon.definition);
    await settle();
    daemon.run();
    await settle();
    host.emit('SIGTERM');
    daemon.result.resolve({ clean: true });
    expect(await exited.promise).toBe(0);
    expect(await running).toBe(0);
    expect(exit).toHaveBeenCalledWith(0);
    expect(vi.getTimerCount()).toBe(baselineTimers);
    expect(host.listenerCount('SIGTERM')).toBe(baselineSigterm);
    expect(host.listenerCount('SIGINT')).toBe(baselineSigint);
    expect(host.listenerCount('uncaughtException')).toBe(baselineUncaught);
    expect(host.listenerCount('unhandledRejection')).toBe(baselineRejection);
  });
});

describe('A2: uncaught suppression', () => {
  const launch = async () => {
    const fake = fakeIo(ARGV_FILE);
    const daemon = scriptedDaemon();
    const running = runDaemonEntry(fake.io, daemon.definition);
    await settle();
    daemon.run();
    await settle();
    return { fake, daemon, running };
  };

  it('1000 distinct uncaught events produce exactly one entry.uncaught and one entry.uncaught_suppressed line, abort once, exit 1, suppressedUncaught=999', async () => {
    const { fake, daemon, running } = await launch();
    for (let i = 0; i < 1000; i += 1) fake.uncaught(new Error(`distinct ${i}`));
    await settle();
    daemon.result.resolve({ clean: true });
    expect(await running).toBe(1);
    const lines = fake.sinkLines();
    expect(lines.filter((line) => line.msg === 'entry.uncaught')).toHaveLength(1);
    expect(lines.filter((line) => line.msg === 'entry.uncaught_suppressed')).toHaveLength(1);
    expect(daemon.abort).toHaveBeenCalledTimes(1);
    const final = lines.at(-1);
    expect(final?.msg).toBe('entry.exit');
    expect(final?.['data'] ?? final).toMatchObject({});
    const data = (final?.['data'] as Record<string, unknown>) ?? final;
    expect((data as { suppressedUncaught: unknown }).suppressedUncaught).toBe(999);
  });

  it('a clean run reports suppressedUncaught=0 in entry.exit', async () => {
    const { fake, daemon, running } = await launch();
    fake.signal('SIGTERM');
    daemon.result.resolve({ clean: true });
    expect(await running).toBe(0);
    const final = fake.sinkLines().at(-1);
    const data = (final?.['data'] as Record<string, unknown>) ?? final;
    expect((data as { suppressedUncaught: unknown }).suppressedUncaught).toBe(0);
  });
});

describe('A3: fatal during aborting', () => {
  it('SIGINT then fatal, abort returns clean:true: exit 1, entry.fatal logged, abort called once', async () => {
    const fake = fakeIo(ARGV_FILE);
    const daemon = scriptedDaemon();
    const running = runDaemonEntry(fake.io, daemon.definition);
    await settle();
    daemon.run();
    await settle();
    fake.signal('SIGINT');
    await settle();
    daemon.fatal.resolve(new Error('fatal while aborting'));
    await settle();
    daemon.result.resolve({ clean: true });
    expect(await running).toBe(1);
    expect(daemon.abort).toHaveBeenCalledTimes(1);
    const lines = fake.sinkLines();
    expect(lines.some((line) => line.msg === 'entry.fatal')).toBe(true);
  });
});

describe('A4: path bound to the settled method', () => {
  it('SIGTERM starts close, a second SIGTERM starts abort, close resolves first: path is close', async () => {
    const closeDeferred = deferred<DaemonCloseResult>();
    const abortDeferred = deferred<DaemonCloseResult>();
    const close = vi.fn(() => closeDeferred.promise);
    const abort = vi.fn(() => abortDeferred.promise);
    const fatal = deferred<Error>();
    const handle: DaemonHandle = { close, abort, fatal: fatal.promise };
    const daemon = scriptedDaemon({ start: async () => handle });
    const fake = fakeIo(ARGV_FILE);
    const running = runDaemonEntry(fake.io, daemon.definition);
    await settle();
    fake.signal('SIGTERM');
    await settle();
    fake.signal('SIGTERM');
    await settle();
    closeDeferred.resolve({ clean: true });
    expect(await running).toBe(0);
    const final = fake.sinkLines().at(-1);
    const data = (final?.['data'] as Record<string, unknown>) ?? final;
    expect((data as { path: unknown }).path).toBe('close');
  });
});
