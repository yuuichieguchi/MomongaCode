import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { shortTempBase } from '@momonga/foundation';
import * as testkit from '@momonga/testkit';
import { TEST_RUN_ENV, createTempDir, registerOwned, registerCleanup, removeTempDir, tempDirPrefixFor, systemTempRoot, testRunToken, testTempBases, afterMicrotasks } from '@momonga/testkit';

describe('createTempDir and removeTempDir', () => {
  it('creates a resolved 0700 directory carrying the run token under the base of other directories', async () => {
    const dir = createTempDir();
    try {
      expect(dir).toBe(fs.realpathSync(dir));
      expect(path.dirname(dir)).toBe(systemTempRoot());
      expect(path.basename(dir).startsWith(tempDirPrefixFor(testRunToken()))).toBe(true);
      expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    } finally {
      await removeTempDir(dir);
    }
  });

  it('creates a home under the base of homes', async () => {
    const home = createTempDir({ asHome: true });
    try {
      expect(path.dirname(home)).toBe(fs.realpathSync(shortTempBase(process.platform, os.tmpdir())));
    } finally {
      await removeTempDir(home);
    }
  });

  it('creates a folder of its own inside a folder the test already holds, removed with that folder', async () => {
    const parent = createTempDir();
    try {
      const first = createTempDir({ parent });
      const second = createTempDir({ parent });
      expect([path.dirname(first), path.dirname(second)]).toEqual([parent, parent]);
      expect(first).not.toBe(second);
      expect(path.basename(first).startsWith(tempDirPrefixFor(testRunToken()))).toBe(true);
    } finally {
      await removeTempDir(parent);
    }
  });

  it('names a folder with the given prefix inside the given parent, when a prefix is set', async () => {
    const parent = createTempDir();
    try {
      const dir = createTempDir({ parent, prefix: 'mme-abcd-' });
      expect(path.dirname(dir)).toBe(parent);
      expect(path.basename(dir).startsWith('mme-abcd-')).toBe(true);
      expect(path.basename(dir).length).toBe('mme-abcd-'.length + 6);
      expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    } finally {
      await removeTempDir(parent);
    }
  });

  it('names the system temporary folder resolved, the base of folders that are not homes', () => {
    expect(systemTempRoot()).toBe(fs.realpathSync(os.tmpdir()));
  });

  it('removes a directory whose subdirectories were made read-only', async () => {
    const dir = createTempDir();
    const locked = path.join(dir, 'locked');
    fs.mkdirSync(path.join(locked, 'inner'), { recursive: true });
    fs.chmodSync(path.join(locked, 'inner'), 0o500);
    fs.chmodSync(locked, 0o500);
    await removeTempDir(dir);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('refuses to create a directory when the run token is not set, since no sweep would find it', () => {
    const token = process.env[TEST_RUN_ENV];
    delete process.env[TEST_RUN_ENV];
    try {
      expect(() => createTempDir()).toThrow(`${TEST_RUN_ENV} is not set`);
    } finally {
      process.env[TEST_RUN_ENV] = token;
    }
  });

  it('names both bases once each for the sweep and keeps the base rule out of the index', () => {
    expect(testTempBases()).toEqual([...new Set([fs.realpathSync(shortTempBase(process.platform, os.tmpdir())), systemTempRoot()])]);
    expect(testkit).not.toHaveProperty('tempDirBase');
  });
});

describe('registerOwned', () => {
  const events: string[] = [];

  it('registers the cleanup before it calls the start', async () => {
    const order: string[] = [];
    const cleanups: Array<() => Promise<void>> = [];
    const handle = await registerOwned(
      (cleanup) => {
        order.push('registered');
        cleanups.push(cleanup);
      },
      async () => {
        order.push('started');
        return { close: async () => void order.push('closed') };
      },
    );
    expect(order).toEqual(['registered', 'started']);
    for (const cleanup of cleanups) await cleanup();
    expect(order).toEqual(['registered', 'started', 'closed']);
    expect(handle).toHaveProperty('close');
  });

  it('registers a cleanup that waits for a start still in flight', async (context) => {
    registerCleanup(context, () => void events.push('home removed'));
    let settle: () => void = () => undefined;
    void registerOwned(
      context,
      () =>
        new Promise<{ close: () => Promise<void> }>((resolve) => {
          settle = () => resolve({ close: async () => void events.push('closed') });
        }),
    );
    registerCleanup(context, () => {
      events.push('test ended');
      settle();
    });
  });

  it('closed what the start gave before the cleanup registered earlier ran', () => {
    expect(events).toEqual(['test ended', 'closed', 'home removed']);
  });

  it('ends what the start gave by the given close', async () => {
    const ended: string[] = [];
    const cleanups: Array<() => Promise<void>> = [];
    await registerOwned(
      (cleanup) => void cleanups.push(cleanup),
      async () => ({ abort: async () => void ended.push('aborted') }),
      (handle) => handle.abort(),
    );
    for (const cleanup of cleanups) await cleanup();
    expect(ended).toEqual(['aborted']);
  });

  it('hands the rejection of a start to its caller and its cleanup does not fail', async (context) => {
    const failure = new Error('the start failed');
    await expect(registerOwned(context, () => Promise.reject<{ close: () => Promise<void> }>(failure))).rejects.toBe(failure);
  });

  it('hands a start that throws before it returns a promise to its caller as a rejection', async (context) => {
    const failure = new Error('the start threw');
    const start = (): Promise<{ close: () => Promise<void> }> => {
      throw failure;
    };
    await expect(registerOwned(context, start)).rejects.toBe(failure);
  });

  it('keeps a start that fails before its caller looks at it from being an unhandled rejection', async (context) => {
    const failure = new Error('the start failed early');
    const unhandled: unknown[] = [];
    const record = (reason: unknown): void => void unhandled.push(reason);
    process.on('unhandledRejection', record);
    registerCleanup(context, () => void process.off('unhandledRejection', record));

    const started = registerOwned(context, () => Promise.reject<{ close: () => Promise<void> }>(failure));
    await afterMicrotasks();

    expect(unhandled).toEqual([]);
    await expect(started).rejects.toBe(failure);
  });
});
