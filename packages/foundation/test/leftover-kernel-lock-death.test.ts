import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { LOCK_DATABASE_SUFFIX, createOwnedDirectory, kernelLockNamed, lockFormOf, sqliteFileLock, sweepLeftovers } from '@momonga/foundation';
import { claimPathOf, sidecarNameSuffixesOf, sidecarOf, sidecarOwnerOf } from '../src/platform/lock-form.ts';
import type { KernelLockMechanism, LeftoverFiles, LockForm } from '@momonga/foundation';
import { REAL_PROCESS_TEST_TIMEOUT_MS, startClaimHolder, testKernelLock } from '@momonga/testkit';
import { exitOf, startHolder } from './support/lock-processes.ts';
import { makeTemporaryDirectory } from './support/temporary-directory.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const ENTRY_NAME = 'entry.json.tmp';

const MECHANISMS: readonly KernelLockMechanism[] = [...new Set([testKernelLock(), kernelLockNamed('sqlite-lock')])];

const PRIMITIVES: ReadonlyArray<{ test: string; form: LockForm; mechanism: KernelLockMechanism }> = MECHANISMS.map((mechanism) => ({
  test: `the ${mechanism.name} mechanism`,
  form: lockFormOf(mechanism, 'file'),
  mechanism,
}));

const nodeLeftoverFiles: LeftoverFiles = {
  readdir: (directory) => fs.promises.readdir(directory),
  rm: (file) => fs.promises.rm(file, { recursive: true, force: true }),
};

describe('the kernel lock is released when its holder is killed with SIGKILL', () => {
  for (const { test, form, mechanism } of PRIMITIVES) {
    it(
      `${test}: a second process is refused while the holder lives and claims after the kill`,
      async (context) => {
        expect(lockFormOf(mechanism, 'file')).toBe(form);
        const entry = path.join(makeTemporaryDirectory(), ENTRY_NAME);
        const holder = await startHolder(context, entry, mechanism.name);
        expect((await mechanism.claim(entry)).kind).toBe('held');
        holder.kill('SIGKILL');
        expect(await exitOf(holder)).toEqual({ code: null, signal: 'SIGKILL' });
        const after = await mechanism.claim(entry);
        expect(after.kind).toBe('claimed');
        if (after.kind === 'claimed') after.lock.release();
      },
    );
  }
});

describe('R1 on real kernel locks: the sweep keeps an entry whose holder lives and removes it once the holder is killed', () => {
  for (const { test, mechanism } of PRIMITIVES) {
    it(
      `${test}: kept while held, removed with its sidecar after SIGKILL`,
      async (context) => {
        const directory = makeTemporaryDirectory();
        const entry = path.join(directory, ENTRY_NAME);
        const holder = await startHolder(context, entry, mechanism.name);
        const before = fs.readdirSync(directory).sort();
        const registered = [{ directory, isLeftover: (name: string) => name.endsWith('.tmp') }];
        await sweepLeftovers({ directories: registered, lock: mechanism, files: nodeLeftoverFiles });
        expect(fs.readdirSync(directory).sort()).toEqual(before);
        holder.kill('SIGKILL');
        await exitOf(holder);
        await sweepLeftovers({ directories: registered, lock: mechanism, files: nodeLeftoverFiles });
        expect(fs.readdirSync(directory)).toEqual([]);
      },
    );
  }
});

const DIRECTORY_SIDECARS: ReadonlyArray<{ mechanism: KernelLockMechanism; claimPathOf(directory: string): string; sidecarOf(directory: string): string }> = MECHANISMS.map((mechanism) => ({
  mechanism,
  claimPathOf: (directory: string) => claimPathOf(mechanism, directory, lockFormOf(mechanism, 'directory')),
  sidecarOf: (directory: string) => sidecarOf(mechanism, directory),
}));

describe('S2: a directory entry has the sidecar form under every mechanism, on real kernel locks', () => {
  for (const { mechanism, claimPathOf, sidecarOf } of DIRECTORY_SIDECARS) {
    const platform = mechanism.name;
    it(
      `${platform} mechanism: a scratch directory is kept with its sidecar while its holder lives, and both go after SIGKILL`,
      async (context) => {
        expect(lockFormOf(mechanism, 'directory')).toBe('sidecar');
        const parent = makeTemporaryDirectory();
        const scratch = path.join(parent, 'scratch-0a1b2c');
        const holder = await startClaimHolder(context, claimPathOf(scratch), mechanism.name);
        fs.mkdirSync(scratch);
        fs.writeFileSync(path.join(scratch, 'work.txt'), 'in use');
        const registered = [{ directory: parent, isLeftover: (name: string) => name.startsWith('scratch-') }];
        await sweepLeftovers({ directories: registered, lock: mechanism, files: nodeLeftoverFiles });
        expect(fs.existsSync(path.join(scratch, 'work.txt'))).toBe(true);
        expect(fs.existsSync(sidecarOf(scratch))).toBe(true);
        holder.kill('SIGKILL');
        await exitOf(holder);
        await sweepLeftovers({ directories: registered, lock: mechanism, files: nodeLeftoverFiles });
        expect(fs.readdirSync(parent)).toEqual([]);
      },
    );

    it(
      `${platform} mechanism: an orphaned sidecar is removed under its own claim, and kept while held`,
      async (context) => {
        const parent = makeTemporaryDirectory();
        const gone = path.join(parent, 'scratch-gone');
        const holder = await startClaimHolder(context, claimPathOf(gone), mechanism.name);
        const registered = [{ directory: parent, isLeftover: (name: string) => name.startsWith('scratch-') }];
        await sweepLeftovers({ directories: registered, lock: mechanism, files: nodeLeftoverFiles });
        expect(fs.existsSync(sidecarOf(gone))).toBe(true);
        holder.kill('SIGKILL');
        await exitOf(holder);
        await sweepLeftovers({ directories: registered, lock: mechanism, files: nodeLeftoverFiles });
        expect(fs.readdirSync(parent)).toEqual([]);
      },
    );

    it(`${platform} mechanism: createOwnedDirectory locks the sidecar before the directory exists, and dispose removes the directory, then the sidecar`, async () => {
      const parent = makeTemporaryDirectory();
      const existedAtClaim: boolean[] = [];
      const observing = {
        ...mechanism,
        claim: async (lockPath: string) => {
          const directory = sidecarOwnerOf(sidecarNameSuffixesOf(mechanism), lockPath)?.base ?? lockPath;
          existedAtClaim.push(fs.existsSync(directory));
          return mechanism.claim(lockPath);
        },
      };
      const owned = await createOwnedDirectory({ parent, prefix: 'scratch-', lock: observing });
      expect(existedAtClaim).toEqual([false]);
      expect(path.dirname(owned.path)).toBe(parent);
      expect(path.basename(owned.path).startsWith('scratch-')).toBe(true);
      expect(fs.statSync(owned.path).isDirectory()).toBe(true);
      expect(await mechanism.isHeld(claimPathOf(owned.path))).toBe(true);
      const registered = [{ directory: parent, isLeftover: (name: string) => name.startsWith('scratch-') }];
      await sweepLeftovers({ directories: registered, lock: mechanism, files: nodeLeftoverFiles });
      expect(fs.existsSync(owned.path)).toBe(true);
      await owned.dispose();
      expect(fs.readdirSync(parent)).toEqual([]);
    });
  }
});

describe('the sqlite lock database and its journal are one leftover unit', () => {
  it('sweeps a journal beside a leftover entry with the entry, and keeps nothing', async () => {
    const dir = makeTemporaryDirectory();
    const entry = path.join(dir, 'session-3');
    fs.writeFileSync(entry, 'stray');
    fs.writeFileSync(`${entry}${LOCK_DATABASE_SUFFIX}`, '');
    fs.writeFileSync(`${entry}${LOCK_DATABASE_SUFFIX}-journal`, '');
    fs.writeFileSync(path.join(dir, `session-4${LOCK_DATABASE_SUFFIX}-journal`), '');
    const swept = await sweepLeftovers({ directories: [{ directory: dir, isLeftover: () => true }], lock: sqliteFileLock });
    expect(swept.kept).toEqual([]);
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});
