import path from 'node:path';
import { writeFileAtomicallySync } from './atomic-file.ts';
import { nodeFileSystemSync } from './node-file-system.ts';
import type { FileSystemSync } from './node-file-system.ts';
import { assertPrivateRegularFile } from './platform/privacy.ts';
import type { Random } from './random.ts';
import { systemRandom } from './system-random.ts';

export interface SecretKeyFileOptions {
  bytes?: number;
  mustExist?: boolean;
  dependentPath?: string;
}

const KEY_FILE_MODE = 0o600;

export type SecretKeyFile = (keyPath: string, options?: SecretKeyFileOptions) => Uint8Array;

export const createSecretKeyFile = (fs: FileSystemSync, random: Random): SecretKeyFile => {
  const readKey = (keyPath: string, bytes: number): Uint8Array | undefined => {
    let handle: number;
    try {
      handle = fs.openReadNoFollowSync(keyPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return undefined;
      if (code === 'ELOOP') throw new Error(`Key file ${keyPath} is a symlink; refusing to read it`);
      throw error;
    }
    try {
      const stat = fs.fstatSync(handle);
      assertPrivateRegularFile(stat, `Key file ${keyPath}`);
      if (stat.size !== bytes) throw new Error(`Key file ${keyPath} must be exactly ${bytes} bytes, found ${stat.size}`);
      return fs.readFileSync(handle);
    } finally {
      fs.closeSync(handle);
    }
  };

  const createKey = (keyPath: string, bytes: number): Uint8Array => {
    const key = random.bytes(bytes);
    if (writeFileAtomicallySync(fs, random, keyPath, key, { mode: KEY_FILE_MODE, publish: 'create' }).created) return key;
    const winner = readKey(keyPath, bytes);
    if (winner === undefined) throw new Error(`Key file ${keyPath} disappeared while it was being created`);
    return winner;
  };

  return (keyPath: string, options: SecretKeyFileOptions = {}): Uint8Array => {
    const { bytes = 32, mustExist = false, dependentPath } = options;
    const existing = readKey(keyPath, bytes);
    if (existing !== undefined) return existing;
    if (mustExist) {
      if (dependentPath === undefined) throw new Error('secretKeyFile: mustExist requires dependentPath');
      throw new Error(
        `${path.basename(dependentPath)} exists but ${path.basename(keyPath)} is missing at ${keyPath}; stored compaction items can no longer be verified. Move ${dependentPath} aside to start fresh.`,
      );
    }
    return createKey(keyPath, bytes);
  };
};

export const secretKeyFile = createSecretKeyFile(nodeFileSystemSync, systemRandom);
