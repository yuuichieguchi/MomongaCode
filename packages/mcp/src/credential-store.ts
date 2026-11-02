import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { modeIsPrivate, noFollowFlag } from '@momonga/foundation';
import type { MomongaPaths } from '@momonga/foundation';

export interface McpCredentialStore {
  read(key: string): Promise<string | undefined>;
  write(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

export const mcpCredentialDirectory = (paths: Pick<MomongaPaths, 'state'>): string => path.join(paths.state, 'mcp-credentials');

export const createMemoryCredentialStore = (): McpCredentialStore => {
  const entries = new Map<string, string>();
  return {
    read: (key) => Promise.resolve(entries.get(key)),
    write: (key, value) => {
      entries.set(key, value);
      return Promise.resolve();
    },
    remove: (key) => {
      entries.delete(key);
      return Promise.resolve();
    },
  };
};

const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;

const fileFor = (directory: string, key: string): string => path.join(directory, `${createHash('sha256').update(key).digest('hex')}.json`);

const readOwnerOnly = async (file: string): Promise<string | undefined> => {
  let handle: fs.promises.FileHandle;
  try {
    handle = await fs.promises.open(file, fs.constants.O_RDONLY | noFollowFlag());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error(`credential file ${file} is not a regular file`);
    if (!modeIsPrivate(stat, 'file')) {
      throw new Error(`credential file ${file} must have mode 0600, found ${(stat.mode & 0o777).toString(8).padStart(4, '0')}`);
    }
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
};

export const createFileCredentialStore = (directory: string): McpCredentialStore => {
  const ensureDirectory = async (): Promise<void> => {
    await fs.promises.mkdir(directory, { recursive: true, mode: DIRECTORY_MODE });
    await fs.promises.chmod(directory, DIRECTORY_MODE);
  };
  return {
    read: (key) => readOwnerOnly(fileFor(directory, key)),
    write: async (key, value) => {
      await ensureDirectory();
      const target = fileFor(directory, key);
      const temporary = `${target}.${randomBytes(6).toString('hex')}.tmp`;
      const handle = await fs.promises.open(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, FILE_MODE);
      try {
        await handle.writeFile(value, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.promises.rename(temporary, target);
    },
    remove: (key) => fs.promises.rm(fileFor(directory, key), { force: true }),
  };
};
