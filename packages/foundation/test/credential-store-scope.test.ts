import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createFileCredentialStore, createMemoryCredentialStore } from '@momonga/foundation';
import { makeTemporaryDirectory as makeDir } from './support/temporary-directory.ts';

const deferred = (): { promise: Promise<void>; resolve(): void } => {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describe.each([
  ['memory', () => createMemoryCredentialStore()],
  ['file', () => createFileCredentialStore(path.join(makeDir(), 'creds'))],
] as const)('%s credential store: the keyed scope held across an asynchronous function', (_name, make) => {
  it('reads, writes and removes inside the scope and returns what the function returns', async () => {
    const store = make();
    await store.write('k', 'one');
    const result = await store.withKey('k', async (entry) => {
      const before = await entry.read();
      await entry.write('two');
      const after = await entry.read();
      return { before, after };
    });
    expect(result).toEqual({ before: 'one', after: 'two' });
    expect(await store.read('k')).toBe('two');
    await store.withKey('k', (entry) => entry.remove());
    expect(await store.read('k')).toBeUndefined();
  });

  it('two scopes on one key never overlap: the second starts only after the first returns', async () => {
    const store = make();
    const events: string[] = [];
    const firstHeld = deferred();
    const firstStarted = deferred();
    const first = store.withKey('k', async () => {
      events.push('first:start');
      firstStarted.resolve();
      await firstHeld.promise;
      events.push('first:end');
    });
    await firstStarted.promise;
    const second = store.withKey('k', async () => {
      events.push('second:start');
    });
    firstHeld.resolve();
    await Promise.all([first, second]);
    expect(events).toEqual(['first:start', 'first:end', 'second:start']);
  });

  it('update waits for a scope on its key and applies its change after the scope', async () => {
    const store = make();
    await store.write('k', '1');
    const held = deferred();
    const started = deferred();
    const scope = store.withKey('k', async (entry) => {
      started.resolve();
      await held.promise;
      await entry.write(`${(await entry.read()) ?? ''}a`);
    });
    await started.promise;
    const updating = store.update('k', (current) => `${current ?? ''}b`);
    held.resolve();
    await Promise.all([scope, updating]);
    expect(await store.read('k')).toBe('1ab');
  });

  it('a scope on another key does not wait', async () => {
    const store = make();
    const held = deferred();
    const started = deferred();
    const blocking = store.withKey('a', () => {
      started.resolve();
      return held.promise;
    });
    await started.promise;
    await store.withKey('b', (entry) => entry.write('free'));
    expect(await store.read('b')).toBe('free');
    held.resolve();
    await blocking;
  });

  it('a scope whose function throws releases the key and keeps what it wrote', async () => {
    const store = make();
    await expect(
      store.withKey('k', async (entry) => {
        await entry.write('written');
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await store.withKey('k', (entry) => entry.read())).toBe('written');
  });
});

describe('file credential store: the keyed scope across two stores on one directory', () => {
  it('serializes scopes on one key through the file lock', async () => {
    const directory = path.join(makeDir(), 'creds');
    const one = createFileCredentialStore(directory);
    const two = createFileCredentialStore(directory);
    const events: string[] = [];
    const held = deferred();
    const started = deferred();
    const first = one.withKey('k', async () => {
      events.push('one:start');
      started.resolve();
      await held.promise;
      events.push('one:end');
    });
    await started.promise;
    const second = two.withKey('k', async () => {
      events.push('two:start');
    });
    held.resolve();
    await Promise.all([first, second]);
    expect(events).toEqual(['one:start', 'one:end', 'two:start']);
  });
});
