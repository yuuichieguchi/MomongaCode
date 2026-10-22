import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach } from 'vitest';
import { openRuntimeStore } from '@momonga/store';
import type { Claim, Run, RuntimeStore } from '@momonga/store';
import { createFakeClock } from '@momonga/testkit';
import type { FakeClock } from '@momonga/testkit';

export const LEASE_MS = 1000;
export const START_MS = 1_800_000_000_000;

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

export const registerCleanup = (cleanup: () => void): void => {
  cleanups.push(cleanup);
};

export const makeStoreDir = (mode = 0o700): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-'));
  fs.chmodSync(dir, mode);
  registerCleanup(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

export const openStoreAt = (
  dbPath: string,
  clock: FakeClock,
  options: { leaseMs?: number; maxAttempts?: number; maxTotalAttempts?: number } = {},
): RuntimeStore => {
  const store = openRuntimeStore({
    path: dbPath,
    clock,
    leaseMs: options.leaseMs ?? LEASE_MS,
    maxAttempts: options.maxAttempts ?? 5,
    maxTotalAttempts: options.maxTotalAttempts ?? 1000,
  });
  registerCleanup(() => store.close());
  return store;
};

export type Harness = { dir: string; dbPath: string; clock: FakeClock; store: RuntimeStore };

export const harness = (options: { leaseMs?: number; maxAttempts?: number; maxTotalAttempts?: number } = {}): Harness => {
  const dir = makeStoreDir();
  const dbPath = path.join(dir, 'runtime.db');
  const clock = createFakeClock(START_MS);
  const store = openStoreAt(dbPath, clock, options);
  return { dir, dbPath, clock, store };
};

export const rawDb = (dbPath: string): DatabaseSync => {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA busy_timeout = 5000');
  registerCleanup(() => {
    if (db.isOpen) db.close();
  });
  return db;
};

export const newSession = (store: RuntimeStore, cwd = '/work/a') =>
  store.createSession({ cwd, env: { PATH: '/usr/bin' }, permissionMode: 'default', modelAlias: 'fm' });

export const enqueue = (store: RuntimeStore, sessionId: string, input = 'hello', idempotencyKey?: string): Run =>
  store.createRunAndEnqueue(sessionId, {
    input,
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    deadlineAt: START_MS + 3_600_000,
    limits: { maxSteps: 10 },
    pins: { model: 'fm' },
  });

export const mustClaim = (store: RuntimeStore, workerId: string): Claim => {
  const claim = store.claim(workerId);
  if (claim === null) throw new Error(`expected ${workerId} to claim a run`);
  return claim;
};

export const mustRun = (store: RuntimeStore, runId: string): Run => {
  const run = store.getRun(runId);
  if (run === undefined) throw new Error(`run ${runId} not found`);
  return run;
};
