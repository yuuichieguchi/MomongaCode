import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createKernelLockMechanism, createOwnedDirectory, lockFormOf, sweepLeftovers } from '@momonga/foundation';
import type { LeftoverFiles, LockForm } from '@momonga/foundation';
import { REAL_PROCESS_TEST_TIMEOUT_MS, startClaimHolder } from '@momonga/testkit';
import { exitOf, startHolder } from './support/lock-processes.ts';
import { makeTemporaryDirectory } from './support/temporary-directory.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const ENTRY_NAME = 'entry.json.tmp';

const PRIMITIVES: ReadonlyArray<{ test: string; platform: NodeJS.Platform; form: LockForm }> = [
  { test: 'T1, entry form (darwin, O_EXLOCK on the entry)', platform: 'darwin', form: 'entry' },
  { test: 'T2, sidecar form (linux and win32, SQLite BEGIN EXCLUSIVE on <entry>.sqlite)', platform: 'linux', form: 'sidecar' },
];

const nodeLeftoverFiles: LeftoverFiles = {
  readdir: (directory) => fs.promises.readdir(directory),
  rm: (file) => fs.promises.rm(file, { recursive: true, force: true }),
};

describe('the kernel lock is released when its holder is killed with SIGKILL', () => {
  for (const { test, platform, form } of PRIMITIVES) {
    it(
      `${test}: a second process is refused while the holder lives and claims after the kill`,
      async (context) => {
        const mechanism = createKernelLockMechanism(platform);
        expect(lockFormOf(mechanism, 'file')).toBe(form);
        const entry = path.join(makeTemporaryDirectory(), ENTRY_NAME);
        const holder = await startHolder(context, entry, platform);
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
  for (const { test, platform } of PRIMITIVES) {
    it(
      `${test}: kept while held, removed with its sidecar after SIGKILL`,
      async (context) => {
        const mechanism = createKernelLockMechanism(platform);
        const directory = makeTemporaryDirectory();
        const entry = path.join(directory, ENTRY_NAME);
        const holder = await startHolder(context, entry, platform);
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

const DIRECTORY_SIDECARS: ReadonlyArray<{ platform: NodeJS.Platform; claimPathOf(directory: string): string; sidecarOf(directory: string): string }> = [
  { platform: 'darwin', claimPathOf: (directory) => `${directory}.lock`, sidecarOf: (directory) => `${directory}.lock` },
  { platform: 'linux', claimPathOf: (directory) => directory, sidecarOf: (directory) => `${directory}.sqlite` },
];

describe('S2: a directory entry has the sidecar form under every mechanism, on real kernel locks', () => {
  for (const { platform, claimPathOf, sidecarOf } of DIRECTORY_SIDECARS) {
    it(
      `${platform} mechanism: a scratch directory is kept with its sidecar while its holder lives, and both go after SIGKILL`,
      async (context) => {
        const mechanism = createKernelLockMechanism(platform);
        expect(lockFormOf(mechanism, 'directory')).toBe('sidecar');
        const parent = makeTemporaryDirectory();
        const scratch = path.join(parent, 'scratch-0a1b2c');
        const holder = await startClaimHolder(context, claimPathOf(scratch), platform);
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
        const mechanism = createKernelLockMechanism(platform);
        const parent = makeTemporaryDirectory();
        const gone = path.join(parent, 'scratch-gone');
        const holder = await startClaimHolder(context, claimPathOf(gone), platform);
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
      const mechanism = createKernelLockMechanism(platform);
      const parent = makeTemporaryDirectory();
      const existedAtClaim: boolean[] = [];
      const observing = {
        ...mechanism,
        claim: async (lockPath: string) => {
          const directory = platform === 'darwin' ? lockPath.slice(0, -'.lock'.length) : lockPath;
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
