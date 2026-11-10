import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { shortTempBase } from '@momonga/foundation';
import * as testkit from '@momonga/testkit';
import { TEST_RUN_ENV, createTempDir, ownedStart, registerCleanup, removeTempDir, tempDirPrefixFor, testRunToken, testTempBases } from '@momonga/testkit';

describe('createTempDir and removeTempDir', () => {
  it('creates a resolved 0700 directory carrying the run token under the base of other directories', async () => {
    const dir = createTempDir();
    try {
      expect(dir).toBe(fs.realpathSync(dir));
      expect(path.dirname(dir)).toBe(fs.realpathSync(os.tmpdir()));
      expect(path.basename(dir).startsWith(tempDirPrefixFor(testRunToken()))).toBe(true);
      expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    } finally {
      await removeTempDir(dir);
    }
  });

  it('creates a home under the base of homes', async () => {
    const home = createTempDir({ asHome: true });
    try {
      expect(path.dirname(home)).toBe(fs.realpathSync(shortTempBase(process.platform)));
    } finally {
      await removeTempDir(home);
    }
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
    expect(testTempBases()).toEqual([...new Set([shortTempBase(process.platform), os.tmpdir()].map((base) => fs.realpathSync(base)))]);
    expect(testkit).not.toHaveProperty('tempDirBase');
  });
});

describe('ownedStart', () => {
  const events: string[] = [];

  it('registers a cleanup that waits for a start still in flight', async (context) => {
    registerCleanup(context, () => void events.push('home removed'));
    let settle: () => void = () => undefined;
    const started = new Promise<{ close: () => Promise<void> }>((resolve) => {
      settle = () => resolve({ close: async () => void events.push('closed') });
    });
    void ownedStart(context, started);
    registerCleanup(context, () => {
      events.push('test ended');
      settle();
    });
  });

  it('closed what the start gave before the cleanup registered earlier ran', () => {
    expect(events).toEqual(['test ended', 'closed', 'home removed']);
  });

  it('hands the rejection of a start to its caller and its cleanup does not fail', async (context) => {
    const failure = new Error('the start failed');
    await expect(ownedStart(context, Promise.reject<{ close: () => Promise<void> }>(failure))).rejects.toBe(failure);
  });
});
