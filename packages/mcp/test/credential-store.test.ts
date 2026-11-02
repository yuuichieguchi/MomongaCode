import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createFileCredentialStore, createMemoryCredentialStore } from '@momonga/mcp';
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
