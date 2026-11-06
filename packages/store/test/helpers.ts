import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach } from 'vitest';
import { canonicalJson, openDatabase, sha256Hex } from '@momonga/foundation';
import type { RunEventPayload } from '@momonga/protocol';
import { JournalThreadError, createJournalReader, openRuntimeStore } from '@momonga/store';
import type { Claim, ContributionPreparer, HistoryQueryResult, Run, RuntimeStore, RuntimeStoreOptions, TerminalContribution } from '@momonga/store';
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

export type StoreOptions = {
  leaseMs?: number;
  maxAttempts?: number;
  maxTotalAttempts?: number;
  onCommit?: RuntimeStoreOptions['onCommit'];
  contribution?: TerminalContribution;
  preparer?: RuntimeStoreOptions['preparer'];
  home?: string;
};

const unexercised = (): Promise<never> => Promise.reject(new JournalThreadError('this store test double answers no journal facts'));

export const noJournalFacts = { verdict: unexercised, evidence: unexercised, reflectionInput: unexercised };

export const hookPreparer = (hook: TerminalContribution, dbPath: string): ContributionPreparer => ({
  ...noJournalFacts,
  measure: async (request) => {
    const db = openDatabase(dbPath);
    try {
      return createJournalReader(db).measure(hook, request);
    } finally {
      db.close();
    }
  },
});

export const openStoreAt =(dbPath: string, clock: FakeClock, options: StoreOptions = {}): RuntimeStore => {
  const store = openRuntimeStore({
    path: dbPath,
    home: options.home ?? path.dirname(dbPath),
    clock,
    leaseMs: options.leaseMs ?? LEASE_MS,
    maxAttempts: options.maxAttempts ?? 5,
    maxTotalAttempts: options.maxTotalAttempts ?? 1000,
    ...(options.onCommit === undefined ? {} : { onCommit: options.onCommit }),
    ...(options.contribution === undefined ? {} : { preparer: hookPreparer(options.contribution, dbPath) }),
    ...(options.preparer === undefined ? {} : { preparer: options.preparer }),
  });
  registerCleanup(() => store.close());
  return store;
};

export type Harness = { dir: string; dbPath: string; clock: FakeClock; store: RuntimeStore };

export const harness = (options: StoreOptions = {}): Harness => {
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

export const TIMEOUT_MS = 3_600_000;
export const DEADLINE_MS = START_MS + TIMEOUT_MS;

export const enqueue = (store: RuntimeStore, sessionId: string, input = 'hello', idempotencyKey?: string): Run => {
  const result = store.createRunAndEnqueue(sessionId, {
    input,
    ...(idempotencyKey === undefined ? {} : { idempotencyKey, requestDigest: sha256Hex(canonicalJson({ input })) }),
    timeoutMs: TIMEOUT_MS,
    limits: { maxSteps: 10 },
    pins: { model: 'fm' },
  });
  if (result.kind !== 'created' && result.kind !== 'existing') throw new Error(`expected a run, got ${result.kind}`);
  return result.run;
};

export const cancel = (store: RuntimeStore, runId: string): Run => {
  const result = store.requestCancel(runId);
  if (result.kind !== 'ok') throw new Error(`expected run ${runId} to exist, got ${result.kind}`);
  return result.run;
};

export const deadLetterAll = async (store: RuntimeStore): Promise<string[]> => {
  const failures: unknown[] = [];
  const ended = await store.deadLetterExhausted((error) => void failures.push(error));
  if (failures.length > 0) throw failures[0];
  return ended;
};

export const cancelToEnd =async (store: RuntimeStore, runId: string): Promise<Run> => {
  const requested = cancel(store, runId);
  if (requested.status !== 'CANCELLING') throw new Error(`expected run ${runId} to become CANCELLING, got ${requested.status}`);
  const failures: unknown[] = [];
  const finished = await store.finishCancelled((error) => void failures.push(error));
  if (failures.length > 0) throw failures[0];
  if (!finished.includes(runId)) throw new Error(`expected the sweep to finish run ${runId}`);
  return mustRun(store, runId);
};

export const ENVELOPE_KEYS = ['id', 'runId', 'sessionId', 'seq', 'step', 'leaseToken', 'createdAt'] as const;

export const payloadOf = (event: object): Record<string, unknown> =>
  Object.fromEntries(Object.entries(event).filter(([key]) => !(ENVELOPE_KEYS as readonly string[]).includes(key)));

export const callEvent = (callId: string): Extract<RunEventPayload, { type: 'tool.call' }> => ({
  type: 'tool.call',
  callId,
  providerCallId: callId,
  name: 'Write',
  kind: 'edit',
  title: `Write ${callId}`,
  rawInput: { file_path: `/work/a/${callId}.txt` },
  locations: [{ path: `/work/a/${callId}.txt` }],
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

export const recalled = (store: RuntimeStore, visibility: Parameters<RuntimeStore['memories']['recallPage']>[0]) =>
  store.memories.recallPage(visibility, { terms: [], after: null, limit: 1000 }).memories;

export const anchorsOf = (result: HistoryQueryResult) => result.sessions.flatMap((session) => session.runs);
