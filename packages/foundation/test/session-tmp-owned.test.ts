import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createOwnedDirectory, ensureMomongaDirs, ensureSessionTmpDir, momongaPaths } from '@momonga/foundation';
import type { KernelLockMechanism } from '@momonga/foundation';
import { makeShortHomeDirectory, makeTemporaryDirectory } from './support/temporary-directory.ts';
import { expectedKernelLockOn } from '@momonga/testkit';

const MECHANISMS: readonly NodeJS.Platform[] = ['darwin', 'linux'];

const claimPathOfDirectory = (lock: KernelLockMechanism, directory: string): string => (lock.name === 'file-lock' ? `${directory}.lock` : directory);

const directoryOfClaim = (lock: KernelLockMechanism, claimPath: string): string => (lock.name === 'file-lock' ? claimPath.slice(0, -'.lock'.length) : claimPath);

const observing = (lock: KernelLockMechanism): { lock: KernelLockMechanism; existedAtClaim: boolean[] } => {
  const existedAtClaim: boolean[] = [];
  return {
    existedAtClaim,
    lock: {
      ...lock,
      claim: async (claimPath) => {
        existedAtClaim.push(fs.existsSync(directoryOfClaim(lock, claimPath)));
        return lock.claim(claimPath);
      },
    },
  };
};

describe('S9: the session scratch owner takes its claim in L1, through the fixed-name form of createOwnedDirectory', () => {
  for (const platform of MECHANISMS) {
    it(`${platform} mechanism: createOwnedDirectory({ parent, name }) makes parent/name, with its sidecar claimed before mkdir`, async () => {
      const mechanism = expectedKernelLockOn(platform);
      const parent = makeTemporaryDirectory();
      const watched = observing(mechanism);
      const owned = await createOwnedDirectory({ parent, name: 'session-a', lock: watched.lock });
      try {
        expect(owned.path).toBe(path.join(parent, 'session-a'));
        expect(watched.existedAtClaim).toEqual([false]);
        expect(fs.statSync(owned.path).isDirectory()).toBe(true);
        expect(await mechanism.isHeld(claimPathOfDirectory(mechanism, owned.path))).toBe(true);
      } finally {
        await owned.dispose();
      }
    });

    it(`${platform} mechanism: ensureSessionTmpDir claims the sidecar before mkdir, holds it, and a second call in the same process reuses the claim`, async () => {
      const mechanism = expectedKernelLockOn(platform);
      const paths = momongaPaths(makeShortHomeDirectory());
      await ensureMomongaDirs(paths);
      const watched = observing(mechanism);
      const { dir: first, claim } = await ensureSessionTmpDir(paths, 'session-1', { lock: watched.lock });
      expect(claim).toBe('owned');
      expect(first).toBe(path.join(paths.tmp.sessions, 'session-1'));
      expect(watched.existedAtClaim).toEqual([false]);
      expect(await mechanism.isHeld(claimPathOfDirectory(mechanism, first))).toBe(true);
      const second = await ensureSessionTmpDir(paths, 'session-1', { lock: watched.lock });
      expect(second).toEqual({ dir: first, claim: 'owned' });
      expect(watched.existedAtClaim).toEqual([false]);
      expect(await mechanism.isHeld(claimPathOfDirectory(mechanism, first))).toBe(true);
    });
  }
});
