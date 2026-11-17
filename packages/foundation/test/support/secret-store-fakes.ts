import { operationLimit } from '@momonga/foundation';
import type { OperationLimit, SecretProcessPort, SecretProcessResult } from '@momonga/foundation';
import type { SecretStoreFiles } from '@momonga/foundation/secret-store';
import { createFakeClock, createFakeTimers, waitFor } from '@momonga/testkit';
import type { FakeTimers } from '@momonga/testkit';

export const KEYCHAIN_PATH = '/Users/x/Library/Keychains/login.keychain-db';

export const READY: SecretProcessResult = { exitCode: 0, stdout: '    "/Users/x/Library/Keychains/login.keychain-db"\n', stderr: '' };
export const NO_DEFAULT: SecretProcessResult = { exitCode: 1, stdout: '', stderr: 'security: SecKeychainCopyDefault: A default keychain could not be found.\n' };
export const UNKNOWN: SecretProcessResult = { exitCode: 0, stdout: 'garbage\n', stderr: '' };

export const R_ND = 'security reports no default keychain (SecKeychainCopyDefault: A default keychain could not be found.)';
export const R_FG = 'the default keychain /Users/x/Library/Keychains/login.keychain-db does not exist';
export const R_PATH = 'security (Keychain) is not on PATH';
export const R_NOT_GIVEN = 'no secret store was given to this process (MOMONGA_SECRET_BACKEND and MOMONGA_SECRET_PROGRAM are not set)';

export const KEYCHAIN_UNANSWERED_ADVICE = 'the Keychain may be waiting for an answer in a window on your screen: answer it or unlock the login keychain';

export const noStoreRefusal = (reason: string): string =>
  `No secret store was found on this host (${reason}). MomongaCode does not keep sign-in tokens in a plain file unless you ask: set credentials.plaintextTokenFiles to true in your user settings to keep them in a file only you can read.`;

export type Call = { file: string; args: readonly string[]; stdin: string };

export type Answer = (signal: AbortSignal) => Promise<SecretProcessResult>;

export const answering =
  (result: SecretProcessResult): Answer =>
  () =>
    Promise.resolve(result);

export const failing =
  (failure: unknown): Answer =>
  () =>
    Promise.reject(failure);

export const hanging: Answer = (signal) =>
  new Promise((_resolve, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });

export type PerCommandPort = { port: SecretProcessPort; calls: Call[]; signals: AbortSignal[] };

const isReadinessQuestion = (args: readonly string[]): boolean => args.length === 1 && args[0] === 'default-keychain';

export const perCommandPort = (answers: { readiness?: Answer; call: Answer }): PerCommandPort => {
  const calls: Call[] = [];
  const signals: AbortSignal[] = [];
  const readiness = answers.readiness ?? answering(READY);
  const port: SecretProcessPort = (file, args, stdin, signal) => {
    calls.push({ file, args, stdin });
    signals.push(signal);
    return isReadinessQuestion(args) ? readiness(signal) : answers.call(signal);
  };
  return { port, calls, signals };
};

type FileStat = { isFile(): boolean };

export type RecordingFiles = { files: SecretStoreFiles; asked: string[] };

export const recordingFiles = (stat: (path: string) => Promise<FileStat>): RecordingFiles => {
  const asked: string[] = [];
  return {
    asked,
    files: {
      stat: (path) => {
        asked.push(path);
        return stat(path);
      },
    },
  };
};

export const aFile = (): Promise<FileStat> => Promise.resolve({ isFile: () => true });

export const notAFile = (): Promise<FileStat> => Promise.resolve({ isFile: () => false });

export const statFailure = (code: string): (() => Promise<FileStat>) => () => Promise.reject(Object.assign(new Error(`${code}: the fake stat failed`), { code }));

export const keychainFilePresent = (): RecordingFiles => recordingFiles(aFile);

export const keychainFileMissing = (): RecordingFiles => recordingFiles(statFailure('ENOENT'));

export const rejection = async (attempt: Promise<unknown>): Promise<unknown> => {
  let value: unknown;
  try {
    value = await attempt;
  } catch (error) {
    return error;
  }
  throw new Error(`expected the operation to be refused, but it resolved with ${JSON.stringify(value)}`);
};

export type Settlement = { current(): 'pending' | { resolved: unknown } | { rejected: unknown } };

export const settlementOf = (attempt: Promise<unknown>): Settlement => {
  let state: ReturnType<Settlement['current']> = 'pending';
  attempt.then(
    (value) => {
      state = { resolved: value };
    },
    (error: unknown) => {
      state = { rejected: error };
    },
  );
  return { current: () => state };
};

export const rejectionsReported = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));


export const until = (predicate: () => boolean, description: string): Promise<void> => waitFor(predicate, { description });

export type FakeLimit = { limit: OperationLimit; signal: AbortSignal; timers: FakeTimers; pass(): void };

export const fakeLimit = (limitMs: number, label: string, parent: AbortSignal = new AbortController().signal): FakeLimit => {
  const timers = createFakeTimers(createFakeClock(0));
  const limit = operationLimit(parent, limitMs, label, timers);
  return { limit, signal: limit.signal, timers, pass: () => timers.advance(limitMs) };
};

export const deferred = <T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } => {
  let resolve = (_value: T): void => undefined;
  let reject = (_error: unknown): void => undefined;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
};

export const unhandledRejections = (): { seen: unknown[]; stop(): void } => {
  const seen: unknown[] = [];
  const record = (reason: unknown): void => void seen.push(reason);
  process.on('unhandledRejection', record);
  return { seen, stop: () => void process.off('unhandledRejection', record) };
};
