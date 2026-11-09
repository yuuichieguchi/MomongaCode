import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { hostKernelLock } from '@momonga/foundation';
import { REAL_PROCESS_TEST_TIMEOUT_MS, startLockHolder } from '@momonga/testkit';
import type { TrackedChild } from '@momonga/testkit';
import type { HeldKernelLock } from '@momonga/foundation';
import { sweepSessionTmp, sweepSpawnTmp } from '../src/process/tmp-sweep.ts';

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

  it('removes a spawn entry whose lock no one holds', async () => {
    const dir = temporaryDirectory();
    const abandoned = path.join(dir, 'spawn-0a1b2c');
    fs.writeFileSync(abandoned, 'left by a crash');
    await sweepSpawnTmp({ dir, onWarning: noWarning });
    expect(fs.readdirSync(dir)).toEqual([]);
  });
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

  it('keeps an unheld session entry younger than the retention, and removes one older than it', async () => {
    const root = temporaryDirectory();
    fs.writeFileSync(path.join(root, 'young'), 'kept by retention');
    fs.writeFileSync(path.join(root, 'old'), 'past retention');
    const activity: Record<string, { hasActiveRun: boolean; lastActivityAt: number }> = {
      young: { hasActiveRun: false, lastActivityAt: NOW - SEVEN_DAYS_MS + 1 },
      old: { hasActiveRun: false, lastActivityAt: NOW - SEVEN_DAYS_MS },
    };
    const store = { sessionActivity: (id: string) => activity[id] };
    await sweepSessionTmp({ root, store, now: NOW, hasInMemoryState: () => false, onWarning: noWarning });
    expect(fs.readdirSync(root).sort()).toEqual(['young']);
  });
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
      const owner = await startLockHolder(context, directoryClaimPath(scratch));
      fs.mkdirSync(scratch);
      fs.writeFileSync(path.join(scratch, 'out.txt'), 'in use');
      await sweepSpawnTmp({ dir, onWarning: noWarning });
      expect(fs.existsSync(path.join(scratch, 'out.txt'))).toBe(true);
      await killed(owner);
      await sweepSpawnTmp({ dir, onWarning: noWarning });
      expect(fs.readdirSync(dir)).toEqual([]);
    },
    REAL_PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    'keeps a session scratch directory past the retention while its owner lives, and removes it with its sidecar after SIGKILL',
    async (context) => {
      const root = temporaryDirectory();
      const sessionId = 'session-live';
      const scratch = path.join(root, sessionId);
      const owner = await startLockHolder(context, directoryClaimPath(scratch));
      fs.mkdirSync(scratch);
      const store = { sessionActivity: () => ({ hasActiveRun: false, lastActivityAt: NOW - SEVEN_DAYS_MS - 1 }) };
      await sweepSessionTmp({ root, store, now: NOW, hasInMemoryState: () => false, onWarning: noWarning });
      expect(fs.statSync(scratch).isDirectory()).toBe(true);
      await killed(owner);
      await sweepSessionTmp({ root, store, now: NOW, hasInMemoryState: () => false, onWarning: noWarning });
      expect(fs.readdirSync(root)).toEqual([]);
    },
    REAL_PROCESS_TEST_TIMEOUT_MS,
  );
});
