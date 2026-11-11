import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { nodeFileSystem, nodeFileSystemSync, systemRandom, writeFileAtomically, writeFileAtomicallySync } from '@momonga/foundation';
import type { KernelLockMechanism } from '@momonga/foundation';
import { makeTemporaryDirectory } from './support/temporary-directory.ts';
import { expectedKernelLockOn } from '@momonga/testkit';

const MECHANISMS: readonly NodeJS.Platform[] = ['darwin', 'linux'];
const VICTIM_TEXT = 'the file a link points to';
const TARGET_TEXT = 'the published file before the write';

const placeLink = (entry: string, victim: string): void => {
  fs.rmSync(entry, { force: true });
  fs.symlinkSync(victim, entry);
};

const swappingAfterClaim = (mechanism: KernelLockMechanism, victim: string): KernelLockMechanism => ({
  ...mechanism,
  claim: async (lockPath) => {
    const outcome = await mechanism.claim(lockPath);
    placeLink(lockPath, victim);
    return outcome;
  },
  ...(mechanism.claimSync === undefined
    ? {}
    : {
        claimSync: (lockPath: string) => {
          const outcome = (mechanism.claimSync as NonNullable<KernelLockMechanism['claimSync']>)(lockPath);
          placeLink(lockPath, victim);
          return outcome;
        },
      }),
});

const scene = (): { directory: string; target: string; victim: string } => {
  const directory = makeTemporaryDirectory();
  const victim = path.join(makeTemporaryDirectory(), 'victim.txt');
  fs.writeFileSync(victim, VICTIM_TEXT);
  const target = path.join(directory, 'record.json');
  fs.writeFileSync(target, TARGET_TEXT);
  return { directory, target, victim };
};

const outcomeOf = async (work: () => unknown): Promise<'refused' | 'completed'> => {
  try {
    await work();
    return 'completed';
  } catch {
    return 'refused';
  }
};

const WRITERS: ReadonlyArray<{ label: string; run(target: string, lock: KernelLockMechanism): unknown }> = [
  { label: 'async writer', run: (target, lock) => writeFileAtomically(nodeFileSystem, systemRandom, target, 'new content', { mode: 0o600, lock }) },
  { label: 'sync writer', run: (target, lock) => writeFileAtomicallySync(nodeFileSystemSync, systemRandom, target, 'new content', { mode: 0o600, lock }) },
];

describe('S6: a symbolic link placed at the temporary between the claim and the write is never written through', () => {
  for (const platform of MECHANISMS) {
    for (const writer of WRITERS) {
      it(`${platform} mechanism, ${writer.label}: the file the link points to stays unchanged`, async () => {
        const { target, victim } = scene();
        await outcomeOf(() => writer.run(target, swappingAfterClaim(expectedKernelLockOn(platform), victim)));
        expect(fs.readFileSync(victim, 'utf8')).toBe(VICTIM_TEXT);
      });

      it(`${platform} mechanism, ${writer.label}: the write is refused and the published file stays a regular file with its old content`, async () => {
        const { target, victim } = scene();
        expect(await outcomeOf(() => writer.run(target, swappingAfterClaim(expectedKernelLockOn(platform), victim)))).toBe('refused');
        expect(fs.lstatSync(target).isSymbolicLink()).toBe(false);
        expect(fs.readFileSync(target, 'utf8')).toBe(TARGET_TEXT);
      });
    }
  }
});
