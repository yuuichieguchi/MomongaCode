import { PassThrough } from 'node:stream';
import { announceReady } from '@momonga/foundation';
import type { ReadyFields } from '@momonga/foundation';
import type { ChildExit, ChildHandle, SpawnPort, SpawnPortOptions } from '../../src/child-manager.ts';

export type FakeChild = {
  readonly handle: ChildHandle;
  readonly command: string;
  readonly args: readonly string[];
  readonly options: SpawnPortOptions;
  readonly pid: number | undefined;
  readonly stdout: PassThrough;
  readonly stderr: PassThrough;
  readonly lifeline: PassThrough;
  readonly signals: NodeJS.Signals[];
  groupKills: number;
  exit(code: number | null, signal?: NodeJS.Signals | null, options?: { endPipes?: boolean }): void;
  spawnError(error: NodeJS.ErrnoException): void;
  ready(overrides?: Partial<ReadyFields>): void;
  stdoutLine(line: string): void;
  stderrLine(line: string): void;
};

export type FakeSpawnPort = SpawnPort & {
  readonly children: FakeChild[];
  readonly calls: { command: string; args: readonly string[]; options: SpawnPortOptions }[];
  hook: ((command: string, args: readonly string[], options: SpawnPortOptions) => void) | undefined;
  nextFailure: { kind: 'throw'; error: Error } | { kind: 'spawn-error'; error: NodeJS.ErrnoException } | undefined;
  onSignal: ((child: FakeChild, signal: NodeJS.Signals | 'group') => void) | undefined;
  last(): FakeChild;
};

export const errnoError = (code: string, message = code): NodeJS.ErrnoException => Object.assign(new Error(message), { code });

export const createFakeSpawnPort = (options: { firstPid?: number; role?: string } = {}): FakeSpawnPort => {
  let nextPid = options.firstPid ?? 41_000;
  const children: FakeChild[] = [];
  const calls: FakeSpawnPort['calls'] = [];
  const port = ((command: string, args: readonly string[], spawnOptions: SpawnPortOptions): ChildHandle => {
    calls.push({ command, args, options: spawnOptions });
    port.hook?.(command, args, spawnOptions);
    const failure = port.nextFailure;
    port.nextFailure = undefined;
    if (failure?.kind === 'throw') throw failure.error;
    const pid = failure?.kind === 'spawn-error' ? undefined : nextPid++;
    const exitListeners: ((exit: ChildExit) => void)[] = [];
    const errorListeners: ((error: NodeJS.ErrnoException) => void)[] = [];
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const lifeline = new PassThrough();
    const signals: NodeJS.Signals[] = [];
    let child: FakeChild;
    const handle: ChildHandle = {
      pid,
      stdout,
      stderr,
      lifeline,
      onSpawnError: (listener) => {
        errorListeners.push(listener);
      },
      onExit: (listener) => {
        exitListeners.push(listener);
      },
      kill: (signal) => {
        signals.push(signal);
        port.onSignal?.(child, signal);
      },
      killGroup: () => {
        child.groupKills += 1;
        port.onSignal?.(child, 'group');
      },
    };
    child = {
      handle,
      command,
      args,
      options: spawnOptions,
      pid,
      stdout,
      stderr,
      lifeline,
      signals,
      groupKills: 0,
      exit: (code, signal = null, exitOptions = {}) => {
        if (exitOptions.endPipes !== false) {
          stdout.end();
          stderr.end();
        }
        for (const listener of exitListeners) listener({ code, signal });
      },
      spawnError: (error) => {
        stdout.destroy();
        stderr.destroy();
        for (const listener of errorListeners) listener(error);
      },
      ready: (overrides = {}) => {
        announceReady(
          {
            service: options.role ?? 'runtime',
            pid: pid ?? -1,
            version: '1.2.3',
            socketPath: '/fake/run/runtime.sock',
            startedAt: '2026-01-01T00:00:00.000Z',
            ...overrides,
          },
          stdout,
        );
      },
      stdoutLine: (line) => {
        stdout.write(`${line}\n`);
      },
      stderrLine: (line) => {
        stderr.write(`${line}\n`);
      },
    };
    children.push(child);
    if (failure?.kind === 'spawn-error') queueMicrotask(() => child.spawnError(failure.error));
    return handle;
  }) as FakeSpawnPort;
  Object.assign(port, {
    children,
    calls,
    hook: undefined,
    nextFailure: undefined,
    onSignal: undefined,
    last: () => {
      const child = children.at(-1);
      if (child === undefined) throw new Error('no fake child spawned');
      return child;
    },
  });
  return port;
};
