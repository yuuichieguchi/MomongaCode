import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  COMMON_ENTRY_FLAGS,
  DEFAULT_STOP_VALUES,
  ENTRY_HARD_EXIT_MARGIN_MS,
  EntryUsageError,
  ProcessLockHeldError,
  STDIO_EXIT_FLUSH_MS,
  StartupCancelled,
  announceReady,
  exitCodeForStartError,
  nodeEntryIo,
  runDaemonEntry,
} from '@momonga/foundation';
import type { DaemonCloseResult, DaemonDefinition, DaemonHandle, DaemonStartContext, EntryIo, EntrySignal, RotatingLogFile } from '@momonga/foundation';
import { createFakeClock, createFakeTimers, withTempDir } from '@momonga/testkit';

const HOME = '/Users/alice';
const OWN_LOCK = path.join(HOME, '.momonga', 'run', 'runtime.lock');
const LOG_PATH = path.join(HOME, '.momonga', 'logs', 'runtime.log');
const MAX_CLOSE_MS = 1000;
const START_MS = 1_800_000_000_000;

type Flags = typeof COMMON_ENTRY_FLAGS;

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

const fakeIo = (argv: readonly string[]) => {
  const clock = createFakeClock(START_MS);
  const timers = createFakeTimers(clock);
  const events: string[] = [];
  const signalHandlers = new Map<EntrySignal, Array<() => void>>();
  const uncaughtHandlers: Array<(error: Error) => void> = [];
  const lifelines: Array<{ fd: number; onEnd: () => void }> = [];
  const sinkChunks: string[] = [];
  const stderrChunks: string[] = [];
  const stdoutChunks: string[] = [];
  const opened: string[] = [];
  const exits: number[] = [];
  let lifelineFailure: Error | undefined;
  let logFileFailure: Error | undefined;
  const io: EntryIo = {
    argv,
    env: { HOME },
    home: HOME,
    stdout: { write: (chunk) => (stdoutChunks.push(chunk), true) },
    stderr: { write: (chunk) => (stderrChunks.push(chunk), true) },
    clock,
    timers,
    onSignal: (signal, handler) => {
      const list = signalHandlers.get(signal) ?? [];
      list.push(handler);
      signalHandlers.set(signal, list);
      return () => {
        const current = signalHandlers.get(signal) ?? [];
        signalHandlers.set(
          signal,
          current.filter((entry) => entry !== handler),
        );
      };
    },
    onUncaught: (handler) => {
      uncaughtHandlers.push(handler);
      return () => {
        const index = uncaughtHandlers.indexOf(handler);
        if (index !== -1) uncaughtHandlers.splice(index, 1);
      };
    },
    watchLifeline: (fd, handlers) => {
      events.push('watchLifeline');
      if (lifelineFailure !== undefined) throw lifelineFailure;
      lifelines.push({ fd, onEnd: handlers.onEnd });
      return { dispose: () => void events.push('disposeLifeline'), drain: async () => undefined };
    },
    holdOpen: () => {
      events.push('hold');
      return () => events.push('release');
    },
    logFile: (file) => {
      opened.push(file);
      if (logFileFailure !== undefined) throw logFileFailure;
      const sink: RotatingLogFile = {
        write: (entry) => void sinkChunks.push(entry.endsWith('\n') ? entry : `${entry}\n`),
        close: () => undefined,
        droppedLines: 0,
      };
      return sink;
    },
    exit: (code) => void exits.push(code),
  };
  return {
    io,
    timers,
    events,
    lifelines,
    opened,
    exits,
    stdout: () => stdoutChunks.join(''),
    stderrLines: () => parseLines(stderrChunks),
    stderrRaw: () => stderrChunks.join(''),
    sinkLines: () => parseLines(sinkChunks),
    signal: (name: EntrySignal) => {
      for (const handler of [...(signalHandlers.get(name) ?? [])]) handler();
    },
    uncaught: (error: Error) => {
      for (const handler of [...uncaughtHandlers]) handler(error);
    },
    eof: () => {
      for (const lifeline of lifelines) lifeline.onEnd();
    },
    failLifeline: (error: Error) => {
      lifelineFailure = error;
    },
    failLogFile: (error: Error) => {
      logFileFailure = error;
    },
  };
};

const scriptedDaemon = (overrides: Partial<DaemonDefinition<Flags>> = {}) => {
  const start = deferred<DaemonHandle>();
  const result = deferred<DaemonCloseResult>();
  const fatal = deferred<Error>();
  const contexts: Array<DaemonStartContext<Flags>> = [];
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
    logPath: (home) => path.join(home, '.momonga', 'logs', 'runtime.log'),
    isConfigError: (error) => error instanceof Error && error.name === 'ConfigError',
    start: (context) => {
      contexts.push(context);
      return start.promise;
    },
    ...overrides,
  };
  return { definition, start, result, fatal, handle, close, abort, contexts, run: () => start.resolve(handle) };
};

const ARGV_FILE = [`--home=${HOME}`, '--log-target=file'];
const ARGV_LIFELINE = [...ARGV_FILE, '--lifeline-fd=3'];

const launch = async (argv: readonly string[] = ARGV_FILE, overrides: Partial<DaemonDefinition<Flags>> = {}) => {
  const fake = fakeIo(argv);
  const daemon = scriptedDaemon(overrides);
  let exitCode: number | undefined;
  let entryError: unknown;
  const running = runDaemonEntry(fake.io, daemon.definition).then(
    (code) => {
      exitCode = code;
      return code;
    },
    (error: unknown) => {
      entryError = error;
      throw error;
    },
  );
  running.catch(() => undefined);
  await settle();
  return { ...fake, ...daemon, running, exitCode: () => exitCode, entryError: () => entryError };
};

const launchRunning = async (argv: readonly string[] = ARGV_FILE, overrides: Partial<DaemonDefinition<Flags>> = {}) => {
  const launched = await launch(argv, overrides);
  expect(launched.contexts, `start was not called: ${String(launched.entryError())}`).toHaveLength(1);
  launched.run();
  await settle();
  return launched;
};

type Launched = Awaited<ReturnType<typeof launch>>;

const expectFinalExit = (lines: readonly LogLine[], expected: { code: number; path: string; clean: boolean; trigger?: string }): void => {
  const last = lines.at(-1);
  expect(last?.msg).toBe('entry.exit');
  expect(last).toMatchObject({ code: expected.code, path: expected.path, clean: expected.clean });
  if (expected.trigger === undefined) expect(last).not.toHaveProperty('trigger');
  else expect(last?.['trigger']).toBe(expected.trigger);
  expect(lines.filter((line) => line.msg === 'entry.exit')).toHaveLength(1);
};

const finish = async (launched: Launched, code: number): Promise<void> => {
  await settle();
  expect(await launched.running).toBe(code);
  expect(launched.exits).toEqual([code]);
};

afterEach(() => {
  vi.useRealTimers();
});

describe('runDaemonEntry: running state', () => {
  it('SIGTERM closes', async () => {
    const launched = await launchRunning();
    launched.signal('SIGTERM');
    await settle();
    expect(launched.close).toHaveBeenCalledTimes(1);
    launched.result.resolve({ clean: true });
    await finish(launched, 0);
    expect(launched.abort).not.toHaveBeenCalled();
    expectFinalExit(launched.sinkLines(), { code: 0, path: 'close', clean: true, trigger: 'sigterm' });
  });

  it('second SIGTERM aborts', async () => {
    const launched = await launchRunning();
    launched.signal('SIGTERM');
    await settle();
    launched.signal('SIGTERM');
    await settle();
    expect(launched.close).toHaveBeenCalledTimes(1);
    expect(launched.abort).toHaveBeenCalledTimes(1);
    launched.result.resolve({ clean: true });
    await finish(launched, 0);
    expectFinalExit(launched.sinkLines(), { code: 0, path: 'abort', clean: true, trigger: 'sigterm' });
  });

  it('SIGINT aborts directly', async () => {
    const launched = await launchRunning();
    launched.signal('SIGINT');
    await settle();
    expect(launched.abort).toHaveBeenCalledTimes(1);
    expect(launched.close).not.toHaveBeenCalled();
    launched.result.resolve({ clean: true });
    await finish(launched, 0);
    expectFinalExit(launched.sinkLines(), { code: 0, path: 'abort', clean: true, trigger: 'sigint' });
  });

  it('SIGINT during closing aborts', async () => {
    const launched = await launchRunning();
    launched.signal('SIGTERM');
    await settle();
    launched.signal('SIGINT');
    await settle();
    expect(launched.abort).toHaveBeenCalledTimes(1);
    launched.result.resolve({ clean: true });
    await finish(launched, 0);
  });

  it('signals during aborting are logged and ignored', async () => {
    const launched = await launchRunning();
    launched.signal('SIGINT');
    await settle();
    launched.signal('SIGTERM');
    launched.signal('SIGINT');
    await settle();
    expect(launched.abort).toHaveBeenCalledTimes(1);
    expect(launched.close).not.toHaveBeenCalled();
    expect(launched.sinkLines().filter((line) => line.msg === 'entry.signal')).toHaveLength(3);
    launched.result.resolve({ clean: true });
    await finish(launched, 0);
  });

  it('lifeline EOF closes', async () => {
    const launched = await launchRunning(ARGV_LIFELINE);
    expect(launched.lifelines.map((lifeline) => lifeline.fd)).toEqual([3]);
    launched.eof();
    await settle();
    expect(launched.close).toHaveBeenCalledTimes(1);
    expect(launched.sinkLines().some((line) => line.msg === 'entry.lifeline_eof')).toBe(true);
    launched.signal('SIGTERM');
    await settle();
    expect(launched.abort).toHaveBeenCalledTimes(1);
    launched.result.resolve({ clean: true });
    await finish(launched, 0);
    expectFinalExit(launched.sinkLines(), { code: 0, path: 'abort', clean: true, trigger: 'lifeline' });
  });

  it('EOF during closing is ignored', async () => {
    const launched = await launchRunning(ARGV_LIFELINE);
    launched.signal('SIGTERM');
    await settle();
    launched.eof();
    await settle();
    expect(launched.close).toHaveBeenCalledTimes(1);
    expect(launched.abort).not.toHaveBeenCalled();
    launched.result.resolve({ clean: true });
    await finish(launched, 0);
    expectFinalExit(launched.sinkLines(), { code: 0, path: 'close', clean: true, trigger: 'sigterm' });
  });

  it('clean=false gives exit 1', async () => {
    const launched = await launchRunning();
    launched.signal('SIGTERM');
    launched.result.resolve({ clean: false });
    await finish(launched, 1);
    expectFinalExit(launched.sinkLines(), { code: 1, path: 'close', clean: false, trigger: 'sigterm' });
  });

  it('rejected close gives exit 1', async () => {
    const launched = await launchRunning();
    launched.signal('SIGTERM');
    launched.result.reject(new Error('close failed'));
    await finish(launched, 1);
    expectFinalExit(launched.sinkLines(), { code: 1, path: 'close', clean: false, trigger: 'sigterm' });
  });

  it('fatal resolving aborts and exits 1', async () => {
    const launched = await launchRunning();
    launched.fatal.resolve(new Error('server error'));
    await settle();
    expect(launched.abort).toHaveBeenCalledTimes(1);
    expect(launched.close).not.toHaveBeenCalled();
    expect(launched.sinkLines().some((line) => line.msg === 'entry.fatal')).toBe(true);
    launched.result.resolve({ clean: true });
    await finish(launched, 1);
    expectFinalExit(launched.sinkLines(), { code: 1, path: 'abort', clean: false, trigger: 'fatal' });
  });

  it('fatal during closing aborts', async () => {
    const launched = await launchRunning();
    launched.signal('SIGTERM');
    await settle();
    launched.fatal.resolve(new Error('server error'));
    await settle();
    expect(launched.abort).toHaveBeenCalledTimes(1);
    launched.result.resolve({ clean: true });
    await finish(launched, 1);
  });

  it('uncaught error aborts and exits 1', async () => {
    const launched = await launchRunning();
    launched.uncaught(new Error('boom'));
    await settle();
    expect(launched.abort).toHaveBeenCalledTimes(1);
    const uncaught = launched.sinkLines().find((line) => line.msg === 'entry.uncaught');
    expect(uncaught?.['err']).toMatchObject({ name: 'Error', message: 'boom' });
    launched.result.resolve({ clean: true });
    await finish(launched, 1);
    expectFinalExit(launched.sinkLines(), { code: 1, path: 'abort', clean: false, trigger: 'uncaught' });
  });

  it('hard deadline', async () => {
    const launched = await launchRunning();
    launched.signal('SIGTERM');
    await settle();
    launched.timers.advance(MAX_CLOSE_MS + ENTRY_HARD_EXIT_MARGIN_MS - 1);
    await settle();
    expect(launched.exits).toEqual([]);
    launched.timers.advance(1);
    await settle();
    expect(launched.exits).toEqual([1]);
    expectFinalExit(launched.sinkLines(), { code: 1, path: 'deadline', clean: false, trigger: 'sigterm' });
    launched.timers.advance(60_000);
    launched.result.resolve({ clean: true });
    await settle();
    expect(launched.exits).toEqual([1]);
  });
});

describe('runDaemonEntry: starting state', () => {
  it('signal during starting cancels startup', async () => {
    const launched = await launch();
    launched.signal('SIGTERM');
    await settle();
    const signal = launched.contexts[0]?.signal;
    expect(signal?.aborted).toBe(true);
    expect(signal?.reason).toBeInstanceOf(StartupCancelled);
    launched.start.reject(signal?.reason);
    await finish(launched, 1);
    expect(launched.close).not.toHaveBeenCalled();
    expectFinalExit(launched.sinkLines(), { code: 1, path: 'startup-cancelled', clean: false, trigger: 'sigterm' });
  });

  it('lifeline EOF during starting cancels startup', async () => {
    const launched = await launch(ARGV_LIFELINE, {});
    expect(launched.events.filter((event) => event !== 'hold' && event !== 'release')).toEqual(['watchLifeline']);
    launched.eof();
    await settle();
    const signal = launched.contexts[0]?.signal;
    expect(signal?.aborted).toBe(true);
    expect(signal?.reason).toBeInstanceOf(StartupCancelled);
    launched.start.reject(signal?.reason);
    await finish(launched, 1);
    expectFinalExit(launched.sinkLines(), { code: 1, path: 'startup-cancelled', clean: false, trigger: 'lifeline' });
  });

  it('the lifeline is opened before start is called', async () => {
    const order: string[] = [];
    const fake = fakeIo(ARGV_LIFELINE);
    const watch = fake.io.watchLifeline;
    fake.io.watchLifeline = (fd, handlers) => {
      order.push('watchLifeline');
      return watch(fd, handlers);
    };
    const daemon = scriptedDaemon({
      start: () => {
        order.push('start');
        return new Promise<DaemonHandle>(() => undefined);
      },
    });
    void runDaemonEntry(fake.io, daemon.definition).catch(() => undefined);
    await settle();
    expect(order).toEqual(['watchLifeline', 'start']);
  });

  it.each([
    ['a SIGTERM', 'sigterm'],
    ['a lifeline EOF', 'lifeline'],
  ] as const)('cancel during starting where start resolves anyway closes the handle (%s)', async (_name, trigger) => {
    const launched = await launch(ARGV_LIFELINE);
    if (trigger === 'sigterm') launched.signal('SIGTERM');
    else launched.eof();
    await settle();
    launched.run();
    await settle();
    expect(launched.close).toHaveBeenCalledTimes(1);
    expect(launched.abort).not.toHaveBeenCalled();
    launched.result.resolve({ clean: true });
    await finish(launched, 0);
    expectFinalExit(launched.sinkLines(), { code: 0, path: 'close', clean: true, trigger });
  });

  it('lifeline EOF handler is not re-armed but the cancel latch is honoured', async () => {
    const launched = await launch(ARGV_LIFELINE);
    launched.eof();
    await settle();
    launched.run();
    await settle();
    expect(launched.events.filter((event) => event === 'watchLifeline')).toHaveLength(1);
    expect(launched.close).toHaveBeenCalledTimes(1);
    launched.result.resolve({ clean: true });
    await finish(launched, 0);
  });

  it('uncaught during starting exits 1', async () => {
    const launched = await launch();
    launched.uncaught(new Error('early boom'));
    await settle();
    expect(launched.sinkLines().some((line) => line.msg === 'entry.uncaught')).toBe(true);
    const signal = launched.contexts[0]?.signal;
    expect(signal?.aborted).toBe(true);
    launched.start.reject(signal?.reason);
    await finish(launched, 1);
    expect(launched.sinkLines().at(-1)).toMatchObject({ msg: 'entry.exit', code: 1, clean: false, trigger: 'uncaught' });
  });

  it('uncaught during starting forces 1 even when start resolves and closes cleanly', async () => {
    const launched = await launch();
    launched.uncaught(new Error('early boom'));
    await settle();
    launched.run();
    await settle();
    expect(launched.close.mock.calls.length + launched.abort.mock.calls.length).toBe(1);
    launched.result.resolve({ clean: true });
    await finish(launched, 1);
  });

  it('hard deadline applies to a cancelled startup', async () => {
    const launched = await launch();
    launched.timers.advance(10_000);
    launched.signal('SIGTERM');
    await settle();
    launched.timers.advance(MAX_CLOSE_MS + ENTRY_HARD_EXIT_MARGIN_MS - 1);
    await settle();
    expect(launched.exits).toEqual([]);
    launched.timers.advance(1);
    await settle();
    expect(launched.exits).toEqual([1]);
    expectFinalExit(launched.sinkLines(), { code: 1, path: 'deadline', clean: false, trigger: 'sigterm' });
  });

  it('no deadline runs while start is pending without a cancel', async () => {
    const launched = await launch();
    expect(launched.contexts, `start was not called: ${String(launched.entryError())}`).toHaveLength(1);
    launched.timers.advance(10 * (MAX_CLOSE_MS + ENTRY_HARD_EXIT_MARGIN_MS));
    await settle();
    expect(launched.exits).toEqual([]);
  });
});

const requestShutdownOf = (launched: Launched): (() => void) => {
  const context = launched.contexts[0];
  if (context === undefined) throw new Error('start was not called');
  return () => context.requestShutdown();
};

const shutdownRequests = (launched: Launched): LogLine[] => launched.sinkLines().filter((line) => line.msg === 'entry.shutdown_requested');

describe('runDaemonEntry: requestShutdown', () => {
  it("requestShutdown closes once and exits 0 with trigger 'request'", async () => {
    const launched = await launchRunning();
    requestShutdownOf(launched)();
    await settle();
    expect(launched.close).toHaveBeenCalledTimes(1);
    expect(launched.abort).not.toHaveBeenCalled();
    expect(shutdownRequests(launched).map((line) => line['state'])).toEqual(['running']);
    launched.result.resolve({ clean: true });
    await finish(launched, 0);
    expect(launched.abort).not.toHaveBeenCalled();
    expectFinalExit(launched.sinkLines(), { code: 0, path: 'close', clean: true, trigger: 'request' });
  });

  it('requestShutdown twice does not abort', async () => {
    const launched = await launchRunning();
    const requestShutdown = requestShutdownOf(launched);
    requestShutdown();
    await settle();
    requestShutdown();
    await settle();
    expect(launched.close).toHaveBeenCalledTimes(1);
    expect(launched.abort).not.toHaveBeenCalled();
    expect(shutdownRequests(launched).map((line) => line['state'])).toEqual(['running', 'closing']);
    launched.result.resolve({ clean: true });
    await finish(launched, 0);
    expect(launched.abort).not.toHaveBeenCalled();
    expectFinalExit(launched.sinkLines(), { code: 0, path: 'close', clean: true, trigger: 'request' });
  });

  it('a SIGTERM after requestShutdown aborts', async () => {
    const launched = await launchRunning();
    requestShutdownOf(launched)();
    await settle();
    launched.signal('SIGTERM');
    await settle();
    expect(launched.close).toHaveBeenCalledTimes(1);
    expect(launched.abort).toHaveBeenCalledTimes(1);
    launched.result.resolve({ clean: true });
    await finish(launched, 0);
    expectFinalExit(launched.sinkLines(), { code: 0, path: 'abort', clean: true, trigger: 'request' });
  });

  it('requestShutdown during aborting and after exit is ignored', async () => {
    const launched = await launchRunning();
    const requestShutdown = requestShutdownOf(launched);
    launched.signal('SIGINT');
    await settle();
    requestShutdown();
    await settle();
    expect(launched.close).not.toHaveBeenCalled();
    expect(launched.abort).toHaveBeenCalledTimes(1);
    expect(shutdownRequests(launched).map((line) => line['state'])).toEqual(['aborting']);
    launched.result.resolve({ clean: true });
    await finish(launched, 0);
    expectFinalExit(launched.sinkLines(), { code: 0, path: 'abort', clean: true, trigger: 'sigint' });
    const linesAtExit = launched.sinkLines().length;
    expect(() => requestShutdown()).not.toThrow();
    await settle();
    expect(launched.sinkLines()).toHaveLength(linesAtExit);
    expect(launched.close).not.toHaveBeenCalled();
    expect(launched.abort).toHaveBeenCalledTimes(1);
    expect(launched.exits).toEqual([0]);
  });

  it.each([
    ['start rejects', 'reject'],
    ['start resolves anyway', 'resolve'],
  ] as const)('requestShutdown during starting latches the cancel (%s)', async (_name, outcome) => {
    const fake = fakeIo(ARGV_FILE);
    const daemon = scriptedDaemon();
    const scriptedStart = daemon.definition.start;
    daemon.definition.start = (context) => {
      const started = scriptedStart(context);
      context.requestShutdown();
      return started;
    };
    const running = runDaemonEntry(fake.io, daemon.definition);
    await settle();
    const context = daemon.contexts[0];
    expect(context).toBeDefined();
    expect(context?.signal.aborted).toBe(true);
    expect(context?.signal.reason).toBeInstanceOf(StartupCancelled);
    expect(fake.sinkLines().filter((line) => line.msg === 'entry.shutdown_requested').map((line) => line['state'])).toEqual(['starting']);
    if (outcome === 'reject') {
      daemon.start.reject(context?.signal.reason);
      await settle();
      expect(await running).toBe(1);
      expect(fake.exits).toEqual([1]);
      expect(daemon.close).not.toHaveBeenCalled();
      expectFinalExit(fake.sinkLines(), { code: 1, path: 'startup-cancelled', clean: false, trigger: 'request' });
    } else {
      daemon.run();
      await settle();
      expect(daemon.close).toHaveBeenCalledTimes(1);
      expect(daemon.abort).not.toHaveBeenCalled();
      daemon.result.resolve({ clean: true });
      await settle();
      expect(await running).toBe(0);
      expect(fake.exits).toEqual([0]);
      expectFinalExit(fake.sinkLines(), { code: 0, path: 'close', clean: true, trigger: 'request' });
    }
  });

  it('requestShutdown outlives start when called from a promise continuation', async () => {
    const launched = await launchRunning();
    const requestShutdown = requestShutdownOf(launched);
    await Promise.resolve().then(() => requestShutdown());
    await settle();
    expect(launched.close).toHaveBeenCalledTimes(1);
    expect(launched.abort).not.toHaveBeenCalled();
    launched.result.resolve({ clean: true });
    await finish(launched, 0);
    expectFinalExit(launched.sinkLines(), { code: 0, path: 'close', clean: true, trigger: 'request' });
  });

  it('requestShutdown outlives start when called from a timer callback', async () => {
    const launched = await launchRunning();
    const requestShutdown = requestShutdownOf(launched);
    launched.timers.setTimeout(() => requestShutdown(), 250);
    launched.timers.advance(249);
    await settle();
    expect(launched.close).not.toHaveBeenCalled();
    launched.timers.advance(1);
    await settle();
    expect(launched.close).toHaveBeenCalledTimes(1);
    expect(launched.abort).not.toHaveBeenCalled();
    launched.result.resolve({ clean: true });
    await finish(launched, 0);
    expectFinalExit(launched.sinkLines(), { code: 0, path: 'close', clean: true, trigger: 'request' });
  });
});

class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

class RuntimeAlreadyRunningLike extends ProcessLockHeldError {}

const startErrors: Array<[string, number, () => unknown]> = [
  ['a config error', 78, () => new ConfigError('bad settings')],
  ['an EntryUsageError', 78, () => new EntryUsageError('bad flag')],
  ['the own lock held', 77, () => new ProcessLockHeldError('held', OWN_LOCK, 4242)],
  ['a subclass of the own lock error', 77, () => new RuntimeAlreadyRunningLike('runtime already running', OWN_LOCK, 4242)],
  ['another lock held', 1, () => new ProcessLockHeldError('socket held', `${HOME}/.momonga/run/runtime.sock.lock`, 4242)],
  ['a plain Error', 1, () => new Error('boom')],
  ['a non-Error', 1, () => 'string failure'],
  ['a cancelled startup', 1, () => new StartupCancelled()],
];

describe('start errors', () => {
  it.each(startErrors)('exitCodeForStartError maps %s to %i', (_name, code, make) => {
    const isConfigError = (error: unknown): boolean => error instanceof ConfigError;
    expect(exitCodeForStartError({ error: make(), ownLockPath: OWN_LOCK, isConfigError })).toBe(code);
  });

  it.each(startErrors.filter(([name]) => name !== 'a cancelled startup'))('start error mapping: %s exits %i with path start-failed', async (_name, code, make) => {
    const launched = await launch();
    launched.start.reject(make());
    await finish(launched, code);
    expectFinalExit(launched.sinkLines(), { code, path: 'start-failed', clean: false });
  });

  it('lifeline fd not usable gives 78', async () => {
    const fake = fakeIo(ARGV_LIFELINE);
    fake.failLifeline(new EntryUsageError('lifeline fd 3 is not usable: EBADF'));
    const daemon = scriptedDaemon();
    const code = await runDaemonEntry(fake.io, daemon.definition);
    expect(code).toBe(78);
    expect(fake.exits).toEqual([78]);
    expect(daemon.contexts).toHaveLength(0);
    expect(fake.sinkLines().at(-1)).toMatchObject({ msg: 'entry.exit', code: 78, clean: false });
    expect(JSON.stringify(fake.sinkLines())).toContain('lifeline fd 3 is not usable');
  });

  it('lifeline is not opened without the flag', async () => {
    const launched = await launchRunning(ARGV_FILE);
    expect(launched.events).not.toContain('watchLifeline');
    expect(launched.lifelines).toHaveLength(0);
  });
});

describe('usage errors before the sink exists', () => {
  const expectUsageExit = (fake: ReturnType<typeof fakeIo>, daemon: ReturnType<typeof scriptedDaemon>, code: number): void => {
    expect(code).toBe(78);
    expect(fake.exits).toEqual([78]);
    expect(daemon.contexts).toHaveLength(0);
    const stderr = fake.stderrLines();
    expect(stderr).toHaveLength(1);
    expect(fake.stderrRaw().endsWith('\n')).toBe(true);
    expect(stderr.some((line) => line.msg === 'entry.exit')).toBe(false);
    expect(fake.sinkLines()).toEqual([]);
  };

  it('a --app-version flag exits 78 with one JSON line on stderr and no entry.exit, because the version comes from the binary', async () => {
    const fake = fakeIo(['--app-version=1.0.0', `--home=${HOME}`]);
    const daemon = scriptedDaemon();
    expectUsageExit(fake, daemon, await runDaemonEntry(fake.io, daemon.definition));
    expect(fake.opened).toEqual([]);
    expect(fake.stderrRaw()).toContain('unknown flag --app-version');
  });

  it('a home that cannot be resolved is a usage error, before any hook of the daemon sees it', async () => {
    const fake = fakeIo(['--home=relative/home', '--log-target=file']);
    const asked: string[] = [];
    const daemon = scriptedDaemon({
      logPath: (home) => {
        asked.push(home);
        return `${home}/daemon.log`;
      },
    });
    expectUsageExit(fake, daemon, await runDaemonEntry(fake.io, daemon.definition));
    expect(fake.opened).toEqual([]);
    expect(asked).toEqual([]);
    expect(fake.stderrRaw()).toContain('path must be absolute: relative/home');
  });

  it('the hooks of the daemon see the home in its canonical form', async (context) => {
    const directory = withTempDir(context);
    const real = path.join(directory, 'real');
    const alias = path.join(directory, 'alias');
    fs.mkdirSync(real);
    fs.symlinkSync(real, alias);
    const fake = fakeIo([`--home=${alias}`, '--log-target=file']);
    const daemon = scriptedDaemon({
      logPath: (home) => {
        throw new Error(`asked for the log under ${home}`);
      },
    });
    expectUsageExit(fake, daemon, await runDaemonEntry(fake.io, daemon.definition));
    expect(fake.stderrRaw()).toContain(`asked for the log under ${fs.realpathSync(real)}`);
  });

  it('a throwing logPath is a usage error', async () => {
    const fake = fakeIo(['--home=/', '--log-target=file']);
    const daemon = scriptedDaemon({
      logPath: (home) => {
        throw new Error(`no log file under ${home}`);
      },
    });
    expectUsageExit(fake, daemon, await runDaemonEntry(fake.io, daemon.definition));
    expect(fake.opened).toEqual([]);
    expect(fake.stderrRaw()).toContain('no log file under /');
  });

  it('a throwing ownLockPath is a usage error', async () => {
    const fake = fakeIo([`--home=/${'h'.repeat(80)}`, '--log-target=file']);
    const daemon = scriptedDaemon({
      ownLockPath: () => {
        throw new Error('socket path too long: 108 bytes');
      },
    });
    expectUsageExit(fake, daemon, await runDaemonEntry(fake.io, daemon.definition));
    expect(fake.opened).toEqual([]);
  });

  it('invalid --log-target gives 78', async () => {
    const fake = fakeIo([`--home=${HOME}`, '--log-target=syslog']);
    const daemon = scriptedDaemon();
    expectUsageExit(fake, daemon, await runDaemonEntry(fake.io, daemon.definition));
    expect(fake.stderrRaw()).toContain('syslog');
  });

  it('--home defaults to io.home', async () => {
    const launched = await launchRunning(['--log-target=file']);
    expect(launched.contexts[0]?.home).toBe(HOME);
    expect(launched.opened).toEqual([LOG_PATH]);
  });
});

describe('log targets and stdout', () => {
  const closeCleanly = async (launched: Launched): Promise<void> => {
    launched.signal('SIGTERM');
    launched.result.resolve({ clean: true });
    await finish(launched, 0);
  };

  it('stdout only has the ready line', async () => {
    const launched = await launch([`--home=${HOME}`, '--log-target=both']);
    expect(launched.contexts, `start was not called: ${String(launched.entryError())}`).toHaveLength(1);
    const fields = { service: 'runtime', pid: 4242, version: '1.0.0', socketPath: `${HOME}/.momonga/run/runtime.sock`, startedAt: new Date(START_MS).toISOString() };
    const context = launched.contexts[0] as DaemonStartContext<Flags>;
    announceReady(fields, context.stdout);
    context.logger.info('daemon.started');
    launched.run();
    await settle();
    await closeCleanly(launched);
    expect(launched.stdout()).toBe(`${JSON.stringify({ event: 'ready', ...fields })}\n`);
    expect(launched.sinkLines().length).toBeGreaterThan(0);
    expect(launched.stderrLines().length).toBeGreaterThan(0);
  });

  it('log target file', async () => {
    const launched = await launchRunning([`--home=${HOME}`, '--log-target=file']);
    await closeCleanly(launched);
    expect(launched.opened).toEqual([LOG_PATH]);
    const messages = launched.sinkLines().map((line) => line.msg);
    expect(messages[0]).toBe('entry.start');
    expect(messages.at(-1)).toBe('entry.exit');
    expect(launched.sinkLines()[0]).toMatchObject({ service: 'runtime', logTarget: 'file' });
    expect(launched.stderrRaw()).toBe('');
  });

  it('log target both', async () => {
    const launched = await launchRunning([`--home=${HOME}`, '--log-target=both']);
    await closeCleanly(launched);
    expect(launched.opened).toEqual([LOG_PATH]);
    expect(launched.sinkLines().length).toBeGreaterThanOrEqual(2);
    expect(launched.stderrLines()).toEqual(launched.sinkLines());
  });

  it('log target defaults to both', async () => {
    const launched = await launchRunning([`--home=${HOME}`]);
    await closeCleanly(launched);
    expect(launched.opened).toEqual([LOG_PATH]);
    expect(launched.stderrLines()).toEqual(launched.sinkLines());
    expect(launched.sinkLines()[0]).toMatchObject({ msg: 'entry.start', logTarget: 'both' });
  });

  it('log target stderr', async () => {
    const launched = await launchRunning([`--home=${HOME}`, '--log-target=stderr']);
    await closeCleanly(launched);
    expect(launched.opened).toEqual([]);
    expect(launched.sinkLines()).toEqual([]);
    expect(launched.stderrLines().at(-1)).toMatchObject({ msg: 'entry.exit', code: 0, path: 'close', clean: true });
  });

  it('log sink open failure falls back to stderr', async () => {
    const fake = fakeIo([`--home=${HOME}`, '--log-target=file']);
    fake.failLogFile(Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }));
    const daemon = scriptedDaemon();
    const running = runDaemonEntry(fake.io, daemon.definition);
    running.catch(() => undefined);
    await settle();
    expect(daemon.contexts).toHaveLength(1);
    daemon.run();
    await settle();
    fake.signal('SIGTERM');
    daemon.result.resolve({ clean: true });
    expect(await running).toBe(0);
    const stderr = fake.stderrLines();
    expect(stderr.filter((line) => line.msg === 'entry.log_sink_failed')).toHaveLength(1);
    expect(stderr.map((line) => line.msg)).toContain('entry.start');
    expect(stderr.at(-1)).toMatchObject({ msg: 'entry.exit', code: 0 });
  });
});

const exitScenarios: Array<[string, (launched: Launched) => Promise<void>, { code: number; path: string }]> = [
  ['close', async (launched) => (launched.signal('SIGTERM'), launched.result.resolve({ clean: true })), { code: 0, path: 'close' }],
  ['abort', async (launched) => (launched.signal('SIGINT'), launched.result.resolve({ clean: true })), { code: 0, path: 'abort' }],
  ['request', async (launched) => (requestShutdownOf(launched)(), launched.result.resolve({ clean: true })), { code: 0, path: 'close' }],
  ['unclean close', async (launched) => (launched.signal('SIGTERM'), launched.result.resolve({ clean: false })), { code: 1, path: 'close' }],
  ['fatal', async (launched) => (launched.fatal.resolve(new Error('f')), await settle(), launched.result.resolve({ clean: true })), { code: 1, path: 'abort' }],
  [
    'deadline',
    async (launched) => {
      launched.signal('SIGTERM');
      await settle();
      launched.timers.advance(MAX_CLOSE_MS + ENTRY_HARD_EXIT_MARGIN_MS);
    },
    { code: 1, path: 'deadline' },
  ],
];

describe('every path', () => {
  it.each(exitScenarios)('entry.exit is the last line and exit is called once: %s', async (_name, drive, expected) => {
    const launched = await launchRunning();
    await drive(launched);
    await settle();
    launched.timers.advance(60_000);
    await settle();
    expect(launched.exits).toEqual([expected.code]);
    const last = launched.sinkLines().at(-1);
    expect(last).toMatchObject({ msg: 'entry.exit', code: expected.code, path: expected.path, clean: expected.code === 0 });
  });
});

const fakeStream = () => {
  const emitter = new EventEmitter();
  const pendingCallbacks: Array<() => void> = [];
  let holdCallbacks = false;
  const stream = Object.assign(emitter, {
    written: [] as string[],
    write: (chunk: string, callback?: () => void): boolean => {
      stream.written.push(chunk);
      if (callback !== undefined) {
        if (holdCallbacks) pendingCallbacks.push(callback);
        else setImmediate(callback);
      }
      return true;
    },
    hold: () => {
      holdCallbacks = true;
    },
    release: () => {
      for (const callback of pendingCallbacks.splice(0)) callback();
    },
  });
  return stream;
};

const fakeHost = () => {
  const stdout = fakeStream();
  const stderr = fakeStream();
  const exit = vi.fn();
  const host = Object.assign(new EventEmitter(), {
    argv: ['/usr/bin/node', '/app/bin.ts', '--log-target=file'],
    env: { HOME: '/Users/host' } as Record<string, string | undefined>,
    stdout,
    stderr,
    exit,
    exitCode: undefined as number | undefined,
    pid: 4242,
  });
  return { host, stdout, stderr, exit, asProcess: host as unknown as NodeJS.Process };
};

describe('nodeEntryIo', () => {
  it('nodeEntryIo smoke', () => {
    const { host, asProcess } = fakeHost();
    const io = nodeEntryIo(asProcess);
    expect(io.argv).toEqual(['--log-target=file']);
    expect(io.home).toBe('/Users/host');
    expect(io.env['HOME']).toBe('/Users/host');
    const handler = vi.fn();
    const before = host.listenerCount('SIGTERM');
    const dispose = io.onSignal('SIGTERM', handler);
    expect(host.listenerCount('SIGTERM')).toBe(before + 1);
    expect(host.listenerCount('SIGINT')).toBe(0);
    host.emit('SIGTERM');
    expect(handler).toHaveBeenCalledTimes(1);
    dispose();
    expect(host.listenerCount('SIGTERM')).toBe(before);
  });

  it('onUncaught receives uncaught exceptions and unhandled rejections', () => {
    const { host, asProcess } = fakeHost();
    const io = nodeEntryIo(asProcess);
    const handler = vi.fn();
    const dispose = io.onUncaught(handler);
    const thrown = new Error('thrown');
    host.emit('uncaughtException', thrown);
    host.emit('unhandledRejection', 'not an error');
    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler.mock.calls[0]?.[0]).toBe(thrown);
    expect(handler.mock.calls[1]?.[0]).toBeInstanceOf(Error);
    dispose();
    expect(host.listenerCount('uncaughtException')).toBe(0);
    expect(host.listenerCount('unhandledRejection')).toBe(0);
  });

  it('nodeEntryIo installs error handlers on stdout and stderr', () => {
    const { stdout, stderr, asProcess } = fakeHost();
    const io = nodeEntryIo(asProcess);
    const handler = vi.fn();
    io.onUncaught(handler);
    expect(stdout.listenerCount('error')).toBe(1);
    expect(stderr.listenerCount('error')).toBe(1);
    const epipe = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
    expect(() => stdout.emit('error', epipe)).not.toThrow();
    expect(() => stderr.emit('error', epipe)).not.toThrow();
    expect(handler).not.toHaveBeenCalled();
  });

  it('nodeEntryIo.exit sets exitCode and exits after the streams flush', async () => {
    const { host, exit, asProcess } = fakeHost();
    const io = nodeEntryIo(asProcess);
    io.exit(3);
    expect(host.exitCode).toBe(3);
    await settle();
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(3);
  });

  it('nodeEntryIo.exit flushes before exiting', async () => {
    const { stderr, exit, asProcess } = fakeHost();
    stderr.hold();
    const io = nodeEntryIo(asProcess);
    io.exit(2);
    await settle();
    expect(exit).not.toHaveBeenCalled();
    stderr.release();
    await settle();
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(2);
  });

  it('nodeEntryIo.exit gives up on the flush after STDIO_EXIT_FLUSH_MS', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { stderr, exit, asProcess } = fakeHost();
    stderr.hold();
    const io = nodeEntryIo(asProcess);
    io.exit(2);
    await settle();
    vi.advanceTimersByTime(STDIO_EXIT_FLUSH_MS - 1);
    await settle();
    expect(exit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    await settle();
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(2);
  });
});
