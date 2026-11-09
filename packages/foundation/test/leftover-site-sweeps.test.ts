import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { hostKernelLock, leftoverDirectories, momongaPaths, nodeFileLockOps, sweepLeftovers } from '@momonga/foundation';
import type { FileLockOps, HeldKernelLock } from '@momonga/foundation';
import { createLockedFile } from '../src/platform/lock-capability.ts';
import { OPEN_FLAGS } from '../src/node-file-system.ts';
import { makeTemporaryDirectory } from './support/temporary-directory.ts';

const PID_NO_PROCESS_HAS = 99_999_999;

const holdEntry = async (entry: string): Promise<HeldKernelLock> => {
  const outcome = await hostKernelLock().claim(entry);
  if (outcome.kind !== 'claimed') throw new Error(`${entry} could not be claimed by the test`);
  if (!fs.existsSync(entry)) fs.writeFileSync(entry, 'in flight', { mode: 0o600 });
  return outcome.lock;
};

describe('secret-key-file.ts:41-49 replaced (S1): the gateway start sweeps dirname(gatewayKey) through the registered list, by lock alone', () => {
  it('keeps a held temporary whose name carries a pid the probe reports dead, and removes an unheld one named with this live pid', async () => {
    const paths = momongaPaths(makeTemporaryDirectory());
    const directory = path.dirname(paths.gatewayKey);
    fs.mkdirSync(directory, { recursive: true });
    const held = path.join(directory, `.gateway.key.${PID_NO_PROCESS_HAS}aabbcc.tmp`);
    const unheld = path.join(directory, `.gateway.key.${process.pid}ddeeff.tmp`);
    const lock = await holdEntry(held);
    fs.writeFileSync(unheld, 'left by a crash', { mode: 0o600 });
    try {
      const registered = leftoverDirectories(paths).filter((entry) => entry.directory === directory);
      expect(registered).toHaveLength(1);
      await sweepLeftovers({ directories: registered, lock: hostKernelLock(), files: { readdir: (dir) => fs.promises.readdir(dir), rm: (file) => fs.promises.rm(file, { force: true }) } });
      expect(fs.existsSync(held)).toBe(true);
      expect(fs.existsSync(unheld)).toBe(false);
    } finally {
      lock.release();
    }
  });
});

describe('lock-capability.ts:43,79: two creators of one locked file never remove each other\'s staged file', () => {
  it('gives each creator its own staged name and never removes the first creator\'s staged file while it is being initialized', () => {
    const directory = makeTemporaryDirectory();
    const file = path.join(directory, 'proof', 'shared.lock');
    fs.mkdirSync(path.dirname(file));
    const stagedOpens: string[] = [];
    const recording: FileLockOps = {
      ...nodeFileLockOps,
      open: (lockPath, flags, mode) => {
        stagedOpens.push(lockPath);
        return nodeFileLockOps.open(lockPath, flags, mode);
      },
    };
    let firstStagedSurvived: boolean | undefined;
    const descriptors: number[] = [];
    const secondCreator = (): void => {
      try {
        descriptors.push(createLockedFile(recording, file, OPEN_FLAGS.readOnly, 0o600));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    };
    try {
      descriptors.push(
        createLockedFile(recording, file, OPEN_FLAGS.readOnly, 0o600, (firstStaged) => {
          secondCreator();
          firstStagedSurvived = fs.existsSync(firstStaged);
        }),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    } finally {
      for (const descriptor of descriptors) fs.closeSync(descriptor);
    }
    const sameFileOpens = stagedOpens.filter((opened) => opened.includes('shared.lock'));
    expect(sameFileOpens.length).toBe(2);
    expect(new Set(sameFileOpens).size).toBe(2);
    expect(firstStagedSurvived).toBe(true);
  });
});

describe('C3: the registered list of leftover directories is data in momonga-paths.ts', () => {
  it('registers the plan sessions, the state directory of the secret key, the spawn scratch and the session scratch', () => {
    const home = makeTemporaryDirectory();
    const paths = momongaPaths(home);
    const registered = leftoverDirectories(paths).map((entry) => entry.directory);
    expect(registered).toEqual(expect.arrayContaining([paths.planSessions, path.dirname(paths.gatewayKey), paths.tmp.spawn, paths.tmp.sessions]));
    expect(new Set(registered).size).toBe(registered.length);
  });

  it('names only temporaries as leftovers, never a published file', () => {
    const paths = momongaPaths(makeTemporaryDirectory());
    const stateDirectory = leftoverDirectories(paths).find((entry) => entry.directory === path.dirname(paths.gatewayKey));
    expect(stateDirectory?.isLeftover(`.${path.basename(paths.gatewayKey)}.0a1b2c.tmp`)).toBe(true);
    expect(stateDirectory?.isLeftover(path.basename(paths.gatewayKey))).toBe(false);
  });
});
