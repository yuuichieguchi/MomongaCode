import { execFile, spawnSync } from 'node:child_process';
import type { ChildProcess, ExecFileException, ExecFileOptions, SpawnOptions, SpawnSyncOptionsWithStringEncoding, SpawnSyncReturns } from 'node:child_process';
import path from 'node:path';
import { MINIMAL_CHILD_PATH } from '@momonga/foundation';
import { assertFakeSecretStoreEnv, fakeSecretProgramsBin } from './secret-store-env-check.ts';
import { spawnTracked } from './test-support.ts';
import type { CleanupContext, TrackedChild } from './test-support.ts';

export const productTestEnv = (env: Readonly<Record<string, string>> = {}): Record<string, string> => {
  const built = { ...env, PATH: `${fakeSecretProgramsBin()}${path.delimiter}${env['PATH'] ?? MINIMAL_CHILD_PATH}` };
  assertFakeSecretStoreEnv(built, 'a product process');
  return built;
};

export const spawnProduct = (context: CleanupContext | undefined, command: string, args: readonly string[] = [], options: SpawnOptions = {}): TrackedChild => {
  assertFakeSecretStoreEnv(options.env ?? process.env, command);
  return spawnTracked(context, command, args, options);
};

export const spawnProductSync = (command: string, args: readonly string[], options: SpawnSyncOptionsWithStringEncoding): SpawnSyncReturns<string> => {
  assertFakeSecretStoreEnv(options.env ?? process.env, command);
  return spawnSync(command, args, options);
};

export const execProductFile = (
  command: string,
  args: readonly string[],
  options: ExecFileOptions & { encoding: 'utf8' },
  callback: (error: ExecFileException | null, stdout: string, stderr: string) => void,
): ChildProcess => {
  assertFakeSecretStoreEnv(options.env ?? process.env, command);
  return execFile(command, args, options, callback);
};
