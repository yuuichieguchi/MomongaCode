import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { syncDirectorySync } from './atomic-file.ts';
import { isProcessAlive } from './process-alive.ts';
import { assertPrivateRegularFile, noFollowFlag } from './platform/privacy.ts';

export interface SecretKeyFileOptions {
  bytes?: number;
  mustExist?: boolean;
  dependentPath?: string;
}

const readKey = (keyPath: string, bytes: number): Uint8Array | undefined => {
  let fd: number;
  try {
    fd = fs.openSync(keyPath, fs.constants.O_RDONLY | noFollowFlag());
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return undefined;
    if (code === 'ELOOP') throw new Error(`Key file ${keyPath} is a symlink; refusing to read it`);
    throw error;
  }
  try {
    const stat = fs.fstatSync(fd);
    assertPrivateRegularFile(stat, `Key file ${keyPath}`);
    if (stat.size !== bytes) throw new Error(`Key file ${keyPath} must be exactly ${bytes} bytes, found ${stat.size}`);
    return new Uint8Array(fs.readFileSync(fd));
  } finally {
    fs.closeSync(fd);
  }
};

const sweepStaleTemporaries = (keyPath: string): void => {
  const directory = path.dirname(keyPath);
  const prefix = `${path.basename(keyPath)}.`;
  for (const name of fs.readdirSync(directory)) {
    if (!name.startsWith(prefix) || !name.endsWith('.tmp')) continue;
    const owner = /^(\d+)\./.exec(name.slice(prefix.length));
    if (owner !== null && isProcessAlive(Number(owner[1]))) continue;
    fs.rmSync(path.join(directory, name), { force: true });
  }
};

const createKey = (keyPath: string, bytes: number): Uint8Array => {
  const key = randomBytes(bytes);
  const temporary = `${keyPath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
  try {
    fs.writeSync(fd, key);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.linkSync(temporary, keyPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const winner = readKey(keyPath, bytes);
    if (winner === undefined) throw new Error(`Key file ${keyPath} disappeared while it was being created`);
    return winner;
  } finally {
    fs.rmSync(temporary, { force: true });
    syncDirectorySync(path.dirname(keyPath));
  }
  return new Uint8Array(key);
};

export const secretKeyFile = (keyPath: string, options: SecretKeyFileOptions = {}): Uint8Array => {
  const { bytes = 32, mustExist = false, dependentPath } = options;
  const existing = readKey(keyPath, bytes);
  if (existing !== undefined) {
    sweepStaleTemporaries(keyPath);
    return existing;
  }
  if (mustExist) {
    if (dependentPath === undefined) throw new Error('secretKeyFile: mustExist requires dependentPath');
    throw new Error(
      `${path.basename(dependentPath)} exists but ${path.basename(keyPath)} is missing at ${keyPath}; stored compaction items can no longer be verified. Move ${dependentPath} aside to start fresh.`,
    );
  }
  const created = createKey(keyPath, bytes);
  sweepStaleTemporaries(keyPath);
  return created;
};
