import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import * as sqlite from '../src/sqlite.ts';
import { BUSY_WAIT_LIMIT_MS, busyTimeoutMs, openDatabase } from '../src/sqlite.ts';
import { createTempDir } from '@momonga/testkit';

const HEARTBEATS_PER_LEASE = 3;
const DEFAULT_LEASE_MS = 30_000;

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const databaseFile = (): string => {
  const dir = createTempDir();
  fs.chmodSync(dir, 0o700);
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'x.db');
};

const opened = (db: DatabaseSync): DatabaseSync => {
  cleanups.push(() => {
    if (db.isOpen) db.close();
  });
  return db;
};

const busyTimeoutOf = (db: DatabaseSync): unknown => Object.values(db.prepare('PRAGMA busy_timeout').get() ?? {})[0];

describe('the busy wait of a database never exceeds the liveness interval of its writer', () => {
  it('is the heartbeat of a lease of 10 s, in whole milliseconds', () => {
    const heartbeatMs = 10_000 / HEARTBEATS_PER_LEASE;
    expect(busyTimeoutMs(heartbeatMs)).toBe(3333);
    expect(busyTimeoutMs(heartbeatMs)).toBeLessThanOrEqual(heartbeatMs);
  });

  it('is 5000 ms for the default lease, whose heartbeat is longer', () => {
    expect(BUSY_WAIT_LIMIT_MS).toBe(5000);
    expect(busyTimeoutMs(DEFAULT_LEASE_MS / HEARTBEATS_PER_LEASE)).toBe(5000);
  });

  it('is the heartbeat exactly at the limit and one millisecond under it', () => {
    expect(busyTimeoutMs(5000)).toBe(5000);
    expect(busyTimeoutMs(4999)).toBe(4999);
  });

  it('a database opened for a lease of 10 s waits no longer than its heartbeat', () => {
    const db = opened(openDatabase(databaseFile(), { busyTimeoutMs: busyTimeoutMs(10_000 / HEARTBEATS_PER_LEASE) }));
    expect(busyTimeoutOf(db)).toBe(3333);
  });

  it('an open names its busy wait: the module holds no default for it', () => {
    expect(Object.keys(sqlite).filter((name) => name.startsWith('DEFAULT_'))).toEqual([]);
    // @ts-expect-error an open without its busy wait does not compile
    expect(() => openDatabase(databaseFile())).toThrow(TypeError);
  });
});
