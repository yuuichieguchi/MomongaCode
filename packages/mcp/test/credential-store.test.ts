import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ensureMomongaDirs, momongaLayout } from '@momonga/foundation';
import type { FileLockPorts } from '@momonga/foundation';
import { startLockHolder } from '@momonga/testkit';
import { createFileCredentialStore, createMemoryCredentialStore, mcpCredentialDirectory } from '@momonga/mcp';
import { makeDir } from './mcp-harness.ts';

describe.each([
  ['memory', () => createMemoryCredentialStore()],
  ['file', () => createFileCredentialStore(path.join(makeDir(), 'creds'))],
] as const)('%s credential store', (_name, make) => {
  it('returns undefined for a missing key, then what was written, then undefined after removal', async () => {
    const store = make();
    expect(await store.read('k')).toBeUndefined();
    await store.write('k', 'one');
    await store.write('k', 'two');
    expect(await store.read('k')).toBe('two');
    await store.remove('k');
    expect(await store.read('k')).toBeUndefined();
    await store.remove('k');
  });
});

describe('file credential store', () => {
  it('leaves no temporary files and keeps one file per key', async () => {
    const directory = path.join(makeDir(), 'creds');
    const store = createFileCredentialStore(directory);
    await store.write('a', '1');
    await store.write('a', '2');
    await store.write('b', '3');
    const names = fs.readdirSync(directory);
    expect(names).toHaveLength(2);
    expect(names.every((name) => /^[0-9a-f]{64}\.json$/.test(name))).toBe(true);
  });

  it('refuses to read through a symlink', async () => {
    const directory = path.join(makeDir(), 'creds');
    const store = createFileCredentialStore(directory);
    await store.write('k', 'secret');
    const file = path.join(directory, fs.readdirSync(directory)[0] as string);
    const elsewhere = path.join(makeDir(), 'copy.json');
    fs.copyFileSync(file, elsewhere);
    fs.chmodSync(elsewhere, 0o600);
    fs.rmSync(file);
    fs.symlinkSync(elsewhere, file);
    await expect(store.read('k')).rejects.toThrow();
  });
});

describe('file credential store updates', () => {
  const counterOf = async (store: ReturnType<typeof createFileCredentialStore>): Promise<number> => Number(await store.read('counter'));

  it('applies every concurrent read-modify-write from two stores on one directory', async () => {
    const directory = path.join(makeDir(), 'creds');
    const first = createFileCredentialStore(directory);
    const second = createFileCredentialStore(directory);
    await first.write('counter', '0');
    const bump = (current: string | undefined): string => String(Number(current) + 1);
    await Promise.all(Array.from({ length: 10 }, (_unused, index) => (index % 2 === 0 ? first : second).update('counter', bump)));
    expect(await counterOf(first)).toBe(10);
    expect(fs.readdirSync(directory).filter((name) => name.endsWith('.lock'))).toEqual([]);
  });

  it('starts from undefined when the key does not exist yet', async () => {
    const store = createFileCredentialStore(path.join(makeDir(), 'creds'));
    await store.update('fresh', (current) => (current === undefined ? 'created' : 'existed'));
    expect(await store.read('fresh')).toBe('created');
  });

  it('removes the temporary file when the write fails', async () => {
    const directory = path.join(makeDir(), 'creds');
    const store = createFileCredentialStore(directory);
    await store.write('k', 'one');
    const [file] = fs.readdirSync(directory);
    fs.rmSync(path.join(directory, file as string));
    fs.mkdirSync(path.join(directory, file as string));
    await expect(store.write('k', 'two')).rejects.toThrow();
    expect(fs.readdirSync(directory).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });
});

describe('file credential store while another process holds the key lock', () => {
  const steppedPorts = (): FileLockPorts => {
    let now = 1_000_000;
    return {
      clock: { now: () => now },
      sleep: async (ms) => {
        now += ms;
      },
      randomHex: () => 'cafe0001',
    };
  };

  const heldStore = async (context: Parameters<typeof startLockHolder>[0]) => {
    const directory = path.join(makeDir(), 'creds');
    const store = createFileCredentialStore(directory, { ports: steppedPorts(), lockTimeoutMs: 100 });
    await store.write('k', 'tokens');
    const lockPath = path.join(`${directory}.locks`, `${createHash('sha256').update('k').digest('hex')}.json.lock`);
    const holder = await startLockHolder(context, lockPath);
    return { store, holder };
  };

  it.for(['update', 'write', 'remove'] as const)('%s waits for the lock and gives up at the timeout, naming the holder', async (operation, context) => {
    const { store, holder } = await heldStore(context);
    const attempt =
      operation === 'update' ? store.update('k', () => 'changed') : operation === 'write' ? store.write('k', 'changed') : store.remove('k');
    await expect(attempt).rejects.toThrow(`held by process ${holder.pid}`);
    expect(await store.read('k')).toBe('tokens');
  });

  it('keeps serving other keys while one key is held', async (context) => {
    const { store } = await heldStore(context);
    await store.write('other', 'free');
    expect(await store.read('other')).toBe('free');
  });
});

describe('file credential store under the real path layout', () => {
  it('keeps owner-only files in the per-user state directory of a temporary home and survives a new instance', async () => {
    const home = makeDir();
    const paths = momongaLayout(home);
    await ensureMomongaDirs(paths);
    const directory = mcpCredentialDirectory(paths);
    expect(directory).toBe(path.join(home, '.momonga', 'state', 'mcp-credentials'));
    await createFileCredentialStore(directory).write('server|tokens', '{"access_token":"fake"}');

    expect(await createFileCredentialStore(directory).read('server|tokens')).toBe('{"access_token":"fake"}');
    expect(fs.statSync(directory).mode & 0o777).toBe(0o700);
    expect(fs.statSync(paths.state).mode & 0o777).toBe(0o700);
    const [file] = fs.readdirSync(directory);
    expect(fs.statSync(path.join(directory, file as string)).mode & 0o777).toBe(0o600);
    expect(directory.startsWith(fs.realpathSync(home))).toBe(true);
  });
});
