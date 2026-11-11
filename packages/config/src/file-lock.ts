import { createKeyedSerializer, hostPaths, nodeFileSystem, sha256Hex, systemFileLockPorts, withFileLock } from '@momonga/foundation';
import type { FileLockPorts, PathResolver, Random } from '@momonga/foundation';
import { layoutOf } from './layout.ts';

const KEY_HEX_CHARS = 32;
const PRIVATE_DIRECTORY_MODE = 0o700;

export const settingsLockPath = async (home: string, file: string, paths: Pick<PathResolver, 'comparablePath'>): Promise<string> =>
  `${layoutOf(home).run}/settings-${sha256Hex(await paths.comparablePath(file)).slice(0, KEY_HEX_CHARS)}.lock`;

export type SettingsLockPort = { locked<Result>(file: string, signal: AbortSignal, work: () => Promise<Result>): Promise<Result> };

export type SettingsFileLockOptions = { ports?: FileLockPorts; lockTimeoutMs?: number };

const serializeInProcess = createKeyedSerializer();

export const settingsFileLock = (home: string, { ports = systemFileLockPorts, lockTimeoutMs }: SettingsFileLockOptions = {}): SettingsLockPort => ({
  locked: async (file, signal, work) => {
    const paths = hostPaths(signal);
    await nodeFileSystem.mkdir(layoutOf(home).run, PRIVATE_DIRECTORY_MODE);
    const lockPath = await settingsLockPath(home, file, paths);
    return serializeInProcess(await paths.comparablePath(file), () => withFileLock(lockPath, work, { ports, signal, ...(lockTimeoutMs === undefined ? {} : { timeoutMs: lockTimeoutMs }) }), signal);
  },
});

export type SettingsWriterOptions = SettingsFileLockOptions & { signal: AbortSignal };

export type SettingsWriterPorts = { lock: SettingsLockPort; random: Random; signal: AbortSignal };

export const settingsWriterPorts = (home: string, { ports = systemFileLockPorts, lockTimeoutMs, signal }: SettingsWriterOptions): SettingsWriterPorts => ({
  lock: settingsFileLock(home, { ports, ...(lockTimeoutMs === undefined ? {} : { lockTimeoutMs }) }),
  random: ports.random,
  signal,
});
