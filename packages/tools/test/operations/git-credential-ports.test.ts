import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { nodeFileSystem, systemRandom } from '@momonga/foundation';
import type { FileSystem, Random } from '@momonga/foundation';
import { openGitCredentialChannel } from '@momonga/tools';
import { createTempDir } from '@momonga/testkit';

const NONCE_ENV = 'MOMONGA_GIT_CREDENTIAL_NONCE';
const SOCKET_ENV = 'MOMONGA_GIT_CREDENTIAL_SOCKET';
const FIXED_NONCE = 'ab'.repeat(32);
const HELPER = { execPath: process.execPath, script: path.resolve(import.meta.dirname, '..', '..', '..', 'cli', 'src', 'main.ts') };

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const rootOf = (): string => {
  const root = createTempDir();
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
};

const fixedRandom = (asked: number[]): Random => ({
  ...systemRandom,
  hex: (byteLength) => {
    asked.push(byteLength);
    return FIXED_NONCE;
  },
});

const ask = (socketPath: string, nonce: string, prompt: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    let answer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      answer += chunk;
    });
    socket.on('error', reject);
    socket.on('end', () => resolve(answer));
    socket.end(`${JSON.stringify({ nonce, prompt })}\n`);
  });

describe('the git credential channel reaches randomness and the file system through its ports', () => {
  it('the nonce is the value of the injected random, and only an ask that carries it is answered', async () => {
    const asked: number[] = [];
    const channel = await openGitCredentialChannel([{ origin: 'https://forge.test', username: 'x-access-token', password: 'a-fake-token-for-tests' }], { root: rootOf(), random: fixedRandom(asked), files: nodeFileSystem, helper: HELPER });
    cleanups.push(() => channel.close());
    const env = channel.environment({});
    expect(asked).toEqual([32]);
    expect(env[NONCE_ENV]).toBe(FIXED_NONCE);
    const socketPath = env[SOCKET_ENV] as string;
    expect(await ask(socketPath, 'cd'.repeat(32), "Password for 'https://forge.test': ")).toBe('');
    expect(await ask(socketPath, FIXED_NONCE, "Password for 'https://forge.test': ")).toBe('a-fake-token-for-tests\n');
  });

  it('the channel directory and its files are made through the injected file system, owner-only', async () => {
    const opened: Array<{ file: string; mode: number | undefined }> = [];
    const made: string[] = [];
    const files: FileSystem = {
      ...nodeFileSystem,
      mkdtemp: async (prefix) => {
        const directory = await nodeFileSystem.mkdtemp(prefix);
        made.push(directory);
        return directory;
      },
      open: (file, flags, mode) => {
        opened.push({ file, mode });
        return nodeFileSystem.open(file, flags, mode);
      },
    };
    const channel = await openGitCredentialChannel([{ origin: 'https://forge.test', username: 'u', password: 'a-fake-token-for-tests' }], { root: rootOf(), random: systemRandom, files, helper: HELPER });
    cleanups.push(() => channel.close());
    expect(made).toEqual([channel.directory]);
    expect(fs.statSync(channel.directory).mode & 0o777).toBe(0o700);
    expect(opened.map((entry) => [path.basename(entry.file), entry.mode])).toEqual([['askpass', 0o700]]);
    expect(fs.statSync(path.join(channel.directory, 'askpass')).mode & 0o777).toBe(0o700);
  });
});
