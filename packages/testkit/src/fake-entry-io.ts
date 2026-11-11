import { hostPaths, systemClock } from '@momonga/foundation';
import type { Clock, EntryIo, KernelLockMechanism, EntrySignal, RotatingLogFile } from '@momonga/foundation';

export type JsonLine = Record<string, unknown> & { msg?: string };

export type FakeEntryIo = EntryIo & {
  readonly exits: readonly number[];
  readonly exited: Promise<number>;
  readonly lifelineFds: readonly number[];
  readonly logFilePaths: readonly string[];
  readonly lifecycle: readonly string[];
  stdoutText(): string;
  stdoutLines(): string[];
  stderrLines(): string[];
  logLines(path: string): string[];
  signal(name: EntrySignal): void;
  endLifeline(): void;
  uncaught(error: Error): void;
  setDroppedLines(path: string, count: number): void;
};

export type FakeEntryIoOptions = {
  argv: readonly string[];
  home: string;
  env?: Readonly<Record<string, string | undefined>>;
  clock?: Clock;
  timers?: EntryIo['timers'];
  logFile?: (path: string) => RotatingLogFile;
  lockMechanism?: KernelLockMechanism;
  paths?: EntryIo['paths'];
};

const realTimers: EntryIo['timers'] = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

const linesOf = (text: string): string[] => text.split('\n').filter((line) => line !== '');

export const parseJsonLines = (lines: readonly string[]): JsonLine[] => lines.map((line) => JSON.parse(line) as JsonLine);

export const createFakeEntryIo = (options: FakeEntryIoOptions): FakeEntryIo => {
  let stdout = '';
  let stderr = '';
  const exits: number[] = [];
  const lifelineFds: number[] = [];
  const lifelineEnds: Array<() => void> = [];
  const logFiles = new Map<string, string[]>();
  const logFilePaths: string[] = [];
  const lifecycle: string[] = [];
  const signalHandlers = new Map<EntrySignal, Set<() => void>>();
  const uncaughtHandlers = new Set<(error: Error) => void>();
  let resolveExited: (code: number) => void = () => undefined;
  const exited = new Promise<number>((resolve) => {
    resolveExited = resolve;
  });

  const dropped = new Map<string, number>();

  const logFile = (path: string): RotatingLogFile => {
    logFilePaths.push(path);
    if (options.logFile !== undefined) return options.logFile(path);
    const lines = logFiles.get(path) ?? [];
    logFiles.set(path, lines);
    return {
      write: (line) => void lines.push(line.endsWith('\n') ? line.slice(0, -1) : line),
      close: () => undefined,
      get droppedLines() {
        return dropped.get(path) ?? 0;
      },
    };
  };

  return {
    argv: options.argv,
    ...(options.lockMechanism === undefined ? {} : { lockMechanism: options.lockMechanism }),
    env: options.env ?? {},
    home: options.home,
    stdout: {
      write: (chunk) => {
        stdout += chunk;
        return true;
      },
    },
    stderr: {
      write: (chunk) => {
        stderr += chunk;
        return true;
      },
    },
    clock: options.clock ?? systemClock,
    timers: options.timers ?? realTimers,
    onSignal: (signal, handler) => {
      const handlers = signalHandlers.get(signal) ?? new Set<() => void>();
      signalHandlers.set(signal, handlers);
      handlers.add(handler);
      return () => {
        lifecycle.push(`dispose:${signal}`);
        handlers.delete(handler);
      };
    },
    onUncaught: (handler) => {
      uncaughtHandlers.add(handler);
      return () => {
        lifecycle.push('dispose:uncaught');
        uncaughtHandlers.delete(handler);
      };
    },
    watchLifeline: (fd, handlers) => {
      lifelineFds.push(fd);
      lifelineEnds.push(handlers.onEnd);
      return { dispose: () => void lifecycle.push('dispose:lifeline'), drain: async () => undefined };
    },
    logFile,
    paths: options.paths ?? hostPaths,
    holdOpen: () => {
      lifecycle.push('hold');
      return () => void lifecycle.push('release');
    },
    exit: (code) => {
      lifecycle.push(`exit:${code}`);
      exits.push(code);
      resolveExited(code);
    },
    exits,
    exited,
    lifelineFds,
    logFilePaths,
    lifecycle,
    stdoutText: () => stdout,
    stdoutLines: () => linesOf(stdout),
    stderrLines: () => linesOf(stderr),
    logLines: (path) => [...(logFiles.get(path) ?? [])],
    signal: (name) => {
      for (const handler of [...(signalHandlers.get(name) ?? [])]) handler();
    },
    endLifeline: () => {
      for (const onEnd of lifelineEnds) onEnd();
    },
    uncaught: (error) => {
      for (const handler of [...uncaughtHandlers]) handler(error);
    },
    setDroppedLines: (path, count) => {
      dropped.set(path, count);
    },
  };
};
