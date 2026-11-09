import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { listenUnix } from '@momonga/foundation';
import { realProcessTestSignal } from '@momonga/testkit';

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const makeRoot = (): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-'));
  fs.chmodSync(root, 0o700);
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
};

const server = (): http.Server => {
  const created = http.createServer((_request, response) => response.end('ok'));
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        created.closeAllConnections();
        if (!created.listening) {
          resolve();
          return;
        }
        created.close(() => resolve());
      }),
  );
  return created;
};

describe('listenUnix directory hardening', () => {
  it('refuses a socket directory that is a symlink, even to a 0700 directory', async () => {
    const root = makeRoot();
    const real = path.join(root, 'real');
    fs.mkdirSync(real, { mode: 0o700 });
    const link = path.join(root, 'link');
    fs.symlinkSync(real, link);
    const target = server();

    await expect(listenUnix(target, path.join(link, 's.sock'), undefined, realProcessTestSignal())).rejects.toThrow(/symlink/i);

    expect(target.listening).toBe(false);
    expect(fs.readdirSync(real)).toEqual([]);
  });

  it('accepts a real 0700 leaf directory below a symlinked ancestor', async () => {
    const root = makeRoot();
    const realParent = path.join(root, 'p');
    fs.mkdirSync(path.join(realParent, 'd'), { recursive: true, mode: 0o700 });
    fs.chmodSync(path.join(realParent, 'd'), 0o700);
    const alias = path.join(root, 'a');
    fs.symlinkSync(realParent, alias);
    const socketPath = path.join(alias, 'd', 's.sock');
    const target = server();

    await listenUnix(target, socketPath, undefined, realProcessTestSignal());

    expect(target.listening).toBe(true);
    expect(fs.statSync(socketPath).mode & 0o777).toBe(0o600);
  });

  it('refuses a socket directory not owned by the current user', async () => {
    const root = makeRoot();
    const uid = process.getuid?.();
    if (uid === undefined) throw new Error('process.getuid is required on this platform');
    vi.spyOn(process, 'getuid').mockReturnValue(uid + 1);
    const target = server();

    await expect(listenUnix(target, path.join(root, 's.sock'), undefined, realProcessTestSignal())).rejects.toThrow(/own/i);

    expect(target.listening).toBe(false);
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it('refuses a socket directory whose mode is not 0700', async () => {
    const root = makeRoot();
    const loose = path.join(root, 'loose');
    fs.mkdirSync(loose);
    fs.chmodSync(loose, 0o710);

    await expect(listenUnix(server(), path.join(loose, 's.sock'), undefined, realProcessTestSignal())).rejects.toThrow(/0700/);
  });
});
