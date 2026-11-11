import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { nodeFileSystem, systemRandom, BUSY_WAIT_LIMIT_MS } from '@momonga/foundation';
import type { FileSystem } from '@momonga/foundation';
import { openRuntimeStore } from '@momonga/store';
import type { RuntimeStore } from '@momonga/store';
import { createFakeClock, testKernelLock } from '@momonga/testkit';
import { LEASE_MS, START_MS, TIMEOUT_MS, UNASKED_COMMANDS, makeStoreDir, rawDb, registerCleanup } from './helpers.ts';

const never = new AbortController().signal;

type Gate = { hold: () => void; release: () => void; reached: Promise<void> };

type Opened = { store: RuntimeStore; dbPath: string; project: string; gate: Gate };

const open = (): Opened => {
  const root = fs.realpathSync(makeStoreDir());
  const project = path.join(root, 'project');
  fs.mkdirSync(project);
  const dbPath = path.join(root, 'runtime.db');
  let held: Promise<void> | undefined;
  let release = (): void => {};
  let reach = (): void => {};
  const reached = new Promise<void>((resolve) => {
    reach = resolve;
  });
  const gate: Gate = {
    hold: () => {
      held = new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    release: () => release(),
    reached,
  };
  const fileSystem: FileSystem = {
    ...nodeFileSystem,
    realpath: async (file) => {
      if (held !== undefined && file === project) {
        reach();
        await held;
      }
      return nodeFileSystem.realpath(file);
    },
  };
  const store = openRuntimeStore({ busyTimeoutMs: BUSY_WAIT_LIMIT_MS, lock: testKernelLock(), unaskedCommands: UNASKED_COMMANDS, path: dbPath, home: root, clock: createFakeClock(START_MS), leaseMs: LEASE_MS, maxAttempts: 5, maxTotalAttempts: 1000, fileSystem, random: systemRandom });
  registerCleanup(() => store.close());
  return { store, dbPath, project, gate };
};

const writerIsFree = (dbPath: string): boolean => {
  const other = rawDb(dbPath);
  other.exec('PRAGMA busy_timeout = 0');
  other.exec('BEGIN IMMEDIATE');
  other.exec('ROLLBACK');
  return true;
};

const originOf = (dbPath: string, runId: string): unknown => rawDb(dbPath).prepare('SELECT origin FROM runs WHERE id = ?').get(runId)?.['origin'];

const INPUT = { input: 'hello', timeoutMs: TIMEOUT_MS, limits: {}, pins: {} };

describe('the origin of a run is resolved before the transaction that creates it', () => {
  it('holds no write transaction while the folder of a new run is resolved, and stores the resolved origin', async () => {
    const { store, dbPath, project, gate } = open();
    await store.trust.setAsked(project, 'trusted', never);
    const session = store.createSession({ cwd: project, env: {}, permissionMode: 'manual', model: 'fm' });
    gate.hold();

    const creating = store.createRunAndEnqueue(session.id, INPUT);
    await gate.reached;

    expect(writerIsFree(dbPath)).toBe(true);
    expect(store.listRuns(session.id)).toEqual([]);
    gate.release();
    const created = await creating;
    if (created.kind !== 'created') throw new Error(`expected a created run, got ${created.kind}`);
    expect(originOf(dbPath, created.run.id)).toBe('trusted');
  });

  it('holds no write transaction while the folder of a child run is resolved', async () => {
    const { store, dbPath, project, gate } = open();
    const session = store.createSession({ cwd: project, env: {}, permissionMode: 'manual', model: 'fm' });
    const parent = await store.createRunAndEnqueue(session.id, INPUT);
    if (parent.kind !== 'created') throw new Error(`expected a created run, got ${parent.kind}`);
    gate.hold();

    const creating = store.createChildRun({ parentRunId: parent.run.id, parentCallId: 'call-1', input: 'child', model: 'fm', pins: {} });
    await gate.reached;

    expect(writerIsFree(dbPath)).toBe(true);
    expect(store.listChildRuns(parent.run.id)).toEqual([]);
    gate.release();
    const created = await creating;
    if (created.kind !== 'created') throw new Error(`expected a created child run, got ${created.kind}`);
    expect(originOf(dbPath, created.run.id)).toBe('untrusted');
  });

  it('holds no write transaction while the folder of a message that starts a run is resolved', async () => {
    const { store, dbPath, project, gate } = open();
    await store.trust.setAsked(project, 'trusted', never);
    const session = store.createSession({ cwd: project, env: {}, permissionMode: 'manual', model: 'fm' });
    gate.hold();

    const adding = store.inbox.add(session.id, { delivery: 'queue', text: 'queued', run: { timeoutMs: TIMEOUT_MS, limits: {}, pins: {} } });
    await gate.reached;

    expect(writerIsFree(dbPath)).toBe(true);
    gate.release();
    const added = await adding;
    expect(added.kind).toBe('added');
    const [started] = store.listRuns(session.id);
    if (started === undefined) throw new Error('the queued message started no run');
    expect(originOf(dbPath, started.id)).toBe('trusted');
  });

  it('answers a missing session and a missing parent without resolving any folder', async () => {
    const { store } = open();
    expect(await store.createRunAndEnqueue('00000000-0000-7000-8000-000000000000', INPUT)).toEqual({ kind: 'not_found' });
    expect(await store.createChildRun({ parentRunId: '00000000-0000-7000-8000-000000000000', parentCallId: 'call-1', input: 'child', model: 'fm', pins: {} })).toEqual({ kind: 'parent_not_active', status: 'missing' });
  });

  it('checks the identity of the database file through the port, without blocking', async () => {
    const { store } = open();
    const checking = store.checkIdentity();
    expect(checking).toBeInstanceOf(Promise);
    await checking;
  });
});
