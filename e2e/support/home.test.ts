import { spawnSync } from '@momonga/testkit/child-process';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isProcessAlive } from '@momonga/foundation';
import { registerCleanup, spawnTracked, startLockHolder, firstGeneration } from '@momonga/testkit';
import type { CleanupContext } from '@momonga/testkit';
import { OVERLAP_MESSAGE, assertInside, createE2eHome, disposeAll, registerE2eCleanup } from './home.ts';
import { parsePidsFile } from './ledger.ts';
import { E2E_RUN_ENV, currentIdentity, e2eTmpRoot, privateRootName, sharedTempBase } from './run-env.ts';

const realTmp = e2eTmpRoot;

const runToken = (): string => {
  const run = process.env[E2E_RUN_ENV];
  if (run === undefined) throw new Error(`${E2E_RUN_ENV} is not set; the e2e global setup did not run`);
  return run;
};

const liveMarker = (): string => path.join(realTmp(), `mme-${runToken()}-live`);

const ownMarkerCleanup = (context: CleanupContext): void => {
  registerCleanup(context, () => {
    fs.rmSync(liveMarker(), { force: true });
  });
};

const deadPid = (): number => {
  const result = spawnSync('/usr/bin/true');
  if (result.pid === undefined || result.status !== 0) throw new Error('could not obtain a dead pid');
  return result.pid;
};

const entriesWithPrefix = (dir: string, prefix: string): string[] => fs.readdirSync(dir).filter((entry) => entry.startsWith(prefix));

describe('createE2eHome', () => {
  it('names the root mme-<run>-<6> directly in the private e2e temp dir and lays out the home', async (context) => {
    ownMarkerCleanup(context);
    const created = await createE2eHome();
    const run = runToken();
    expect(created.run).toBe(run);
    expect(path.dirname(created.root)).toBe(realTmp());
    expect(path.basename(created.root)).toMatch(new RegExp(`^mme-${run}-[A-Za-z0-9]{6}$`));
    expect(created.home).toBe(created.root);
    expect(created.project).toBe(path.join(created.root, 'p'));
    expect(created.sessionTmp).toBe(path.join(created.root, 'session-tmp'));
    expect(created.upstreamSocket).toBe(path.join(created.root, 'u.sock'));
    for (const dir of [created.root, created.project, created.sessionTmp, created.paths.root]) {
      expect(fs.statSync(dir).isDirectory()).toBe(true);
    }
    expect(fs.statSync(created.project).mode & 0o777).toBe(0o700);
    expect(fs.statSync(created.sessionTmp).mode & 0o777).toBe(0o700);
    expect(created.paths.root).toBe(path.join(created.root, '.momonga'));
    expect(fs.readFileSync(liveMarker(), 'utf8')).toBe(String(process.pid));
    await disposeAll();
    expect(fs.existsSync(created.root)).toBe(false);
    expect(fs.existsSync(liveMarker())).toBe(false);
  });

  it('keeps the longest socket within the budget: supervisor.sock is the shared base, the private mme-<uid> directory and 48 bytes', async (context) => {
    ownMarkerCleanup(context);
    const created = await createE2eHome();
    const longest = Buffer.byteLength(firstGeneration(created.paths).sockets.supervisor);
    const privateRootBytes = Buffer.byteLength(sharedTempBase()) + 1 + Buffer.byteLength(privateRootName(currentIdentity()));
    expect(Buffer.byteLength(realTmp())).toBe(privateRootBytes);
    expect(longest).toBe(privateRootBytes + 48);
    for (const socket of Object.values(firstGeneration(created.paths).sockets)) expect(Buffer.byteLength(socket)).toBeLessThanOrEqual(longest);
  });

  it('rejects a temp dir that would push the longest socket over the budget, naming the budget', async (context) => {
    const base = fs.mkdtempSync(path.join(realTmp(), 'mmx-'));
    registerCleanup(context, () => fs.rmSync(base, { recursive: true, force: true }));
    const long = path.join(base, 'x'.repeat(80 - Buffer.byteLength(base) - 1));
    fs.mkdirSync(long, { mode: 0o700 });
    expect(Buffer.byteLength(long)).toBe(80);
    await expect(createE2eHome({ tmpRoot: long })).rejects.toThrow(/the longest socket of a home in .* is 128 bytes, which leaves no socket-path budget/);
    expect(entriesWithPrefix(long, 'mme-')).toEqual([]);
  });

  it('refuses a root outside the real temp dir', async () => {
    await expect(createE2eHome({ tmpRoot: '/' })).rejects.toThrow(/outside/);
  });

  it('refuses a run token that is not 4 lowercase hex characters', async () => {
    for (const run of ['', 'ABCD', 'abc', 'abcde', 'x']) {
      await expect(createE2eHome({ run })).rejects.toThrow(E2E_RUN_ENV);
    }
  });
});

describe('assertInside', () => {
  it('allows the container itself and a child whose name starts with two dots', () => {
    const container = path.join(path.sep, 'container');
    expect(() => assertInside(container, container)).not.toThrow();
    expect(() => assertInside(path.join(container, '..x'), container)).not.toThrow();
    expect(() => assertInside(path.join(container, '..x', 'deeper'), container)).not.toThrow();
  });

  it('rejects the parent and a sibling of the container', () => {
    const container = path.join(path.sep, 'container');
    expect(() => assertInside(path.sep, container)).toThrow(/outside/);
    expect(() => assertInside(path.join(path.sep, 'sibling'), container)).toThrow(/outside/);
  });
});

describe('single-live-home guard', () => {
  it('throws while a live foreign owner holds the marker', async (context) => {
    ownMarkerCleanup(context);
    const owner = spawnTracked(context, 'sleep', ['30']);
    fs.writeFileSync(liveMarker(), String(owner.pid), { flag: 'wx', mode: 0o600 });
    const before = entriesWithPrefix(realTmp(), `mme-${runToken()}-`).sort();
    await expect(createE2eHome()).rejects.toThrow(OVERLAP_MESSAGE);
    expect(fs.readFileSync(liveMarker(), 'utf8')).toBe(String(owner.pid));
    expect(entriesWithPrefix(realTmp(), `mme-${runToken()}-`).sort()).toEqual(before);
  });

  it('replaces a marker whose owner is dead', async (context) => {
    ownMarkerCleanup(context);
    fs.writeFileSync(liveMarker(), String(deadPid()), { flag: 'wx', mode: 0o600 });
    const created = await createE2eHome();
    expect(fs.readFileSync(liveMarker(), 'utf8')).toBe(String(process.pid));
    expect(fs.existsSync(created.root)).toBe(true);
  });

  it('replaces an empty or unreadable marker', async (context) => {
    ownMarkerCleanup(context);
    fs.writeFileSync(liveMarker(), '', { flag: 'wx', mode: 0o600 });
    await createE2eHome();
    expect(fs.readFileSync(liveMarker(), 'utf8')).toBe(String(process.pid));
    await disposeAll();
    fs.writeFileSync(liveMarker(), 'not a pid', { flag: 'wx', mode: 0o600 });
    await createE2eHome();
    expect(fs.readFileSync(liveMarker(), 'utf8')).toBe(String(process.pid));
  });
});

describe('the ledger of an e2e home', () => {
  it('a health reading persists a tool group that only the runtime database names, without disposeAll', async (context) => {
    ownMarkerCleanup(context);
    const created = await createE2eHome();
    const toolGroup = deadPid();
    fs.mkdirSync(path.dirname(created.paths.databases.runtime), { recursive: true, mode: 0o700 });
    const db = new DatabaseSync(created.paths.databases.runtime);
    db.exec('CREATE TABLE idempotency (key TEXT, pgid INTEGER)');
    db.prepare('INSERT INTO idempotency VALUES (?, ?)').run('a', toolGroup);
    db.close();
    await created.ledger.record({
      status: 'ok',
      version: 'e2e',
      apiVersion: 1,
      pid: 1,
      startedAt: '2026-01-01T00:00:00.000Z',
      phase: 'running',
      env: 'frozen at supervisor start',
      children: [],
      logs: { droppedLines: 0 },
    });
    const pidsFile = created.ledger.pidsFile;
    const persisted = fs.existsSync(pidsFile) ? parsePidsFile(fs.readFileSync(pidsFile, 'utf8')) : [];
    expect(persisted.filter((entry) => entry.pgid === toolGroup)).toEqual([{ pgid: toolGroup, startTime: undefined, source: 'db' }]);
  });
});

describe('disposing a home whose daemon appeared after the ledger was swept', () => {
  it('stops the process that holds the supervisor lock before it removes the home', async (context) => {
    ownMarkerCleanup(context);
    const created = await createE2eHome();
    let holderPid: number | undefined;
    registerE2eCleanup(async () => {
      const generation = firstGeneration(created.paths);
      fs.mkdirSync(generation.dir, { recursive: true, mode: 0o700 });
      holderPid = (await startLockHolder(context, generation.locks.supervisor)).pid;
    });

    await disposeAll();

    expect(holderPid).toBeDefined();
    expect(isProcessAlive(holderPid as number)).toBe(false);
    expect(fs.existsSync(created.root)).toBe(false);
  });
});

describe('registerE2eCleanup and disposeAll', () => {
  it('runs every cleanup, later ones after a failing one, and then throws', async () => {
    const order: string[] = [];
    registerE2eCleanup(() => {
      order.push('first');
    });
    registerE2eCleanup(() => {
      order.push('second');
      throw new Error('second cleanup failed');
    });
    registerE2eCleanup(async () => {
      order.push('third');
    });
    await expect(disposeAll()).rejects.toThrow('second cleanup failed');
    expect([...order].sort()).toEqual(['first', 'second', 'third']);
    await expect(disposeAll()).resolves.toBeUndefined();
  });
});
