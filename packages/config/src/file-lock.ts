import { DEFAULT_LOCK_TIMEOUT_MS, LockWaitTimeoutError, createKeyedSerializer, hostPaths, nodeFileSystem, sha256Hex, systemFileLockPorts, withFileLock } from '@momonga/foundation';
import type { FileLockPorts, KernelLockMechanism, PathResolver, Random, Timing } from '@momonga/foundation';
import { layoutOf } from './layout.ts';

const KEY_HEX_CHARS = 32;
const PRIVATE_DIRECTORY_MODE = 0o700;

export const settingsLockPath = async (home: string, file: string, paths: Pick<PathResolver, 'comparablePath'>): Promise<string> =>
  `${layoutOf(home).run}/settings-${sha256Hex(await paths.comparablePath(file)).slice(0, KEY_HEX_CHARS)}.lock`;

export type SettingsLockPort = { locked<Result>(file: string, signal: AbortSignal, work: () => Promise<Result>): Promise<Result> };

export type SettingsFileLockOptions = { lock: KernelLockMechanism; ports?: FileLockPorts; lockTimeoutMs?: number };

const serializeInProcess = createKeyedSerializer();

const turnWithin = <T>(key: string, file: string, signal: AbortSignal, timing: Timing, timeoutMs: number, work: () => Promise<T>): Promise<T> => {
  const turn = new AbortController();
  const forward = (): void => turn.abort(signal.reason);
  signal.addEventListener('abort', forward, { once: true });
  const bound = timing.setTimeout(() => turn.abort(new LockWaitTimeoutError(file, timeoutMs, String(process.pid))), timeoutMs);
  const run = serializeInProcess(
    key,
    () => {
      timing.clearTimeout(bound);
      signal.removeEventListener('abort', forward);
      return work();
    },
    turn.signal,
  );
  const release = (): void => {
    timing.clearTimeout(bound);
    signal.removeEventListener('abort', forward);
  };
  run.then(release, release);
  return run;
};

export const settingsFileLock = (home: string, { lock, ports = systemFileLockPorts, lockTimeoutMs }: SettingsFileLockOptions): SettingsLockPort => ({
  locked: async (file, signal, work) => {
    const paths = hostPaths(signal);
    await nodeFileSystem.mkdir(layoutOf(home).run, PRIVATE_DIRECTORY_MODE);
    const lockPath = await settingsLockPath(home, file, paths);
    const timeoutMs = lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
    return turnWithin(await paths.comparablePath(file), file, signal, ports.timing, timeoutMs, () => withFileLock(lockPath, work, { ports, mechanism: lock, signal, timeoutMs }));
  },
});

export type SettingsWriterOptions = SettingsFileLockOptions & { signal: AbortSignal };

export type SettingsWriterPorts = { lock: SettingsLockPort; mechanism: KernelLockMechanism; random: Random; signal: AbortSignal };

export const settingsWriterPorts = (home: string, { lock, ports = systemFileLockPorts, lockTimeoutMs, signal }: SettingsWriterOptions): SettingsWriterPorts => ({
  mechanism: lock,
  lock: settingsFileLock(home, { lock, ports, ...(lockTimeoutMs === undefined ? {} : { lockTimeoutMs }) }),
  random: ports.random,
  signal,
});
