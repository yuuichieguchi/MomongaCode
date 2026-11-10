import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Readable } from 'node:stream';
import { createKernelLockMechanism, hostKernelLock, momongaPaths } from '@momonga/foundation';
import type { KernelLockMechanism } from '@momonga/foundation';
import { REAL_PROCESS_TEST_TIMEOUT_MS, spawnTracked, startClaimHolder } from '@momonga/testkit';
import type { CleanupContext, TrackedChild } from '@momonga/testkit';
import type { HeldKernelLock } from '@momonga/foundation';
import { sweepSessionTmp, sweepSpawnTmp } from '../src/process/tmp-sweep.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const SEVEN_DAYS_MS = 7 * 86_400_000;
const NOW = 1_800_000_000_000;

const created: string[] = [];
const held: HeldKernelLock[] = [];

afterEach(() => {
  for (const lock of held.splice(0)) lock.release();
  for (const directory of created.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

const temporaryDirectory = (): string => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mm-runtime-leftover-')));
  created.push(directory);
  return directory;
};

const holdEntry = async (entry: string): Promise<void> => {
  const outcome = await hostKernelLock().claim(entry);
  if (outcome.kind !== 'claimed') throw new Error(`${entry} could not be claimed by the test`);
  held.push(outcome.lock);
  if (!fs.existsSync(entry)) fs.writeFileSync(entry, 'in flight', { mode: 0o600 });
};

const MECHANISMS: readonly NodeJS.Platform[] = ['darwin', 'linux'];

const sidecarNamesOf = (lock: KernelLockMechanism, name: string): string[] => (lock.name === 'sqlite-lock' ? [name, `${name}.sqlite`] : [name]);

const makeLeftover = async (lock: KernelLockMechanism, entry: string, content: string): Promise<void> => {
  const outcome = await lock.claim(entry);
  if (outcome.kind !== 'claimed') throw new Error(`${entry} could not be claimed by the test`);
  fs.writeFileSync(entry, content);
  outcome.lock.release();
};

const noWarning = (message: string): void => {
  throw new Error(`unexpected warning: ${message}`);
};

describe('tmp-sweep.ts:28-44: the spawn scratch sweep never removes an entry whose owner holds its lock', () => {
  it('keeps a held spawn entry when a second runtime starts (the noTempLock variant)', async () => {
    const dir = temporaryDirectory();
    const inUse = path.join(dir, 'spawn-0a1b2c');
    await holdEntry(inUse);
    await sweepSpawnTmp({ dir, onWarning: noWarning });
    expect(fs.existsSync(inUse)).toBe(true);
  });

  for (const platform of MECHANISMS) {
    it(`${platform} mechanism: removes a spawn entry whose lock no one holds, with its sidecar`, async () => {
      const lock = createKernelLockMechanism(platform);
      const dir = temporaryDirectory();
      await makeLeftover(lock, path.join(dir, 'spawn-0a1b2c'), 'left by a crash');
      expect(fs.readdirSync(dir).sort()).toEqual(sidecarNamesOf(lock, 'spawn-0a1b2c'));
      await sweepSpawnTmp({ dir, onWarning: noWarning, lock });
      expect(fs.readdirSync(dir)).toEqual([]);
    });
  }
});

describe('tmp-sweep.ts:47-: age is retention only (R4); a session entry whose owner holds its lock is kept at any age', () => {
  it('keeps a held session entry older than the retention, with no store activity and no in-memory state (the ageRemoval variant)', async () => {
    const root = temporaryDirectory();
    const sessionId = 'session-held';
    const inUse = path.join(root, sessionId);
    await holdEntry(inUse);
    const store = { sessionActivity: () => ({ hasActiveRun: false, lastActivityAt: NOW - SEVEN_DAYS_MS - 1 }) };
    const result = await sweepSessionTmp({ root, store, now: NOW, hasInMemoryState: () => false, onWarning: noWarning });
    expect(fs.existsSync(inUse)).toBe(true);
    expect(result.removed).toBe(0);
  });

  for (const platform of MECHANISMS) {
  it(`${platform} mechanism: keeps an unheld session entry younger than the retention, and removes one older than it`, async () => {
    const lock = createKernelLockMechanism(platform);
    const root = temporaryDirectory();
    await makeLeftover(lock, path.join(root, 'young'), 'kept by retention');
    await makeLeftover(lock, path.join(root, 'old'), 'past retention');
    const activity: Record<string, { hasActiveRun: boolean; lastActivityAt: number }> = {
      young: { hasActiveRun: false, lastActivityAt: NOW - SEVEN_DAYS_MS + 1 },
      old: { hasActiveRun: false, lastActivityAt: NOW - SEVEN_DAYS_MS },
    };
    const store = { sessionActivity: (id: string) => activity[id] };
    await sweepSessionTmp({ root, store, now: NOW, hasInMemoryState: () => false, onWarning: noWarning, lock });
    expect(fs.readdirSync(root).sort()).toEqual(sidecarNamesOf(lock, 'young'));
  });
  }
});

const directoryClaimPath = (directory: string): string => (hostKernelLock().name === 'file-lock' ? `${directory}.lock` : directory);

const killed = (child: TrackedChild): Promise<void> =>
  new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    child.once('exit', () => resolve());
    child.kill('SIGKILL');
  });

describe('S2: spawn and session scratch are directories with a sidecar, on real kernel locks', () => {
  it(
    'keeps a spawn scratch directory and its sidecar while its owner lives, and removes both after the owner is killed with SIGKILL',
    async (context) => {
      const dir = temporaryDirectory();
      const scratch = path.join(dir, 'spawn-0a1b2c');
      const owner = await startClaimHolder(context, directoryClaimPath(scratch));
      fs.mkdirSync(scratch);
      fs.writeFileSync(path.join(scratch, 'out.txt'), 'in use');
      await sweepSpawnTmp({ dir, onWarning: noWarning });
      expect(fs.existsSync(path.join(scratch, 'out.txt'))).toBe(true);
      await killed(owner);
      await sweepSpawnTmp({ dir, onWarning: noWarning });
      expect(fs.readdirSync(dir)).toEqual([]);
    },
  );

  it(
    'keeps a session scratch directory past the retention while its owner lives, and removes it with its sidecar after SIGKILL',
    async (context) => {
      const root = temporaryDirectory();
      const sessionId = 'session-live';
      const scratch = path.join(root, sessionId);
      const owner = await startClaimHolder(context, directoryClaimPath(scratch));
      fs.mkdirSync(scratch);
      const store = { sessionActivity: () => ({ hasActiveRun: false, lastActivityAt: NOW - SEVEN_DAYS_MS - 1 }) };
      await sweepSessionTmp({ root, store, now: NOW, hasInMemoryState: () => false, onWarning: noWarning });
      expect(fs.statSync(scratch).isDirectory()).toBe(true);
      await killed(owner);
      await sweepSessionTmp({ root, store, now: NOW, hasInMemoryState: () => false, onWarning: noWarning });
      expect(fs.readdirSync(root)).toEqual([]);
    },
  );
});

const SESSION_OWNER = path.join(import.meta.dirname, 'fixtures', 'session-tmp-owner.ts');

const startSessionOwner = (context: CleanupContext, home: string, sessionId: string, platform: NodeJS.Platform): Promise<TrackedChild> =>
  new Promise((resolve, reject) => {
    const child = spawnTracked(context, process.execPath, [SESSION_OWNER, home, sessionId, platform], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    (child.stderr as Readable).on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    (child.stdout as Readable).on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      if (stdout.includes('ready\n')) resolve(child);
    });
    child.once('exit', (code, signal) => reject(new Error(`the session owner exited (code ${code}, signal ${signal}) before it was ready: ${stderr}`)));
  });

describe('S9: session scratch made by ensureSessionTmpDir is kept while its owner lives, and goes after SIGKILL and the R4 retention', () => {
  for (const platform of MECHANISMS) {
    it(
      `${platform} mechanism: kept while held past the retention; after SIGKILL kept within the retention and removed past it`,
      async (context) => {
        const lock = createKernelLockMechanism(platform);
        const home = temporaryDirectory();
        const paths = momongaPaths(home);
        fs.mkdirSync(paths.tmp.sessions, { recursive: true, mode: 0o700 });
        const sessionId = 'session-owned';
        const scratch = path.join(paths.tmp.sessions, sessionId);
        const owner = await startSessionOwner(context, home, sessionId, platform);
        const old = { sessionActivity: () => ({ hasActiveRun: false, lastActivityAt: NOW - SEVEN_DAYS_MS }) };
        const young = { sessionActivity: () => ({ hasActiveRun: false, lastActivityAt: NOW - SEVEN_DAYS_MS + 1 }) };
        await sweepSessionTmp({ root: paths.tmp.sessions, store: old, now: NOW, hasInMemoryState: () => false, onWarning: noWarning, lock });
        expect(fs.statSync(scratch).isDirectory()).toBe(true);
        await killed(owner);
        await sweepSessionTmp({ root: paths.tmp.sessions, store: young, now: NOW, hasInMemoryState: () => false, onWarning: noWarning, lock });
        expect(fs.statSync(scratch).isDirectory()).toBe(true);
        await sweepSessionTmp({ root: paths.tmp.sessions, store: old, now: NOW, hasInMemoryState: () => false, onWarning: noWarning, lock });
        expect(fs.readdirSync(paths.tmp.sessions)).toEqual([]);
      },
    );
  }
});
