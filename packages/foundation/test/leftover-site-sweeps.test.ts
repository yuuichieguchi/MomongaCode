import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { leftoverDirectories, momongaPaths, nodeFileLockOps, sweepLeftovers } from '@momonga/foundation';
import type { FileLockOps, HeldKernelLock } from '@momonga/foundation';
import { createLockedFile } from '../src/platform/lock-capability.ts';
import { OPEN_FLAGS } from '../src/node-file-system.ts';
import { makeTemporaryDirectory } from './support/temporary-directory.ts';
import { expectedKernelLockOn, testKernelLock } from '@momonga/testkit';

const PID_NO_PROCESS_HAS = 99_999_999;

const holdEntry = async (entry: string): Promise<HeldKernelLock> => {
  const outcome = await testKernelLock().claim(entry);
  if (outcome.kind !== 'claimed') throw new Error(`${entry} could not be claimed by the test`);
  if (!fs.existsSync(entry)) fs.writeFileSync(entry, 'in flight', { mode: 0o600 });
  return outcome.lock;
};

describe('secret-key-file.ts:41-49 replaced (S1): the gateway start sweeps dirname(gatewayKey) through the registered list, by lock alone', () => {
  for (const platform of ['darwin', 'linux'] as const) {
    it(`${platform} mechanism: keeps a held temporary whose name carries a pid the probe reports dead, and removes an unheld one, with its sidecar, named with this live pid`, async () => {
      const lock = expectedKernelLockOn(platform);
      const paths = momongaPaths(makeTemporaryDirectory());
      const directory = path.dirname(paths.gatewayKey);
      fs.mkdirSync(directory, { recursive: true });
      const held = path.join(directory, `.gateway.key.${PID_NO_PROCESS_HAS}aabbcc.tmp`);
      const unheld = path.join(directory, `.gateway.key.${process.pid}ddeeff.tmp`);
      const holding = await lock.claim(held);
      if (holding.kind !== 'claimed') throw new Error(`${held} could not be claimed by the test`);
      fs.writeFileSync(held, 'in flight', { mode: 0o600 });
      const abandoned = await lock.claim(unheld);
      if (abandoned.kind !== 'claimed') throw new Error(`${unheld} could not be claimed by the test`);
      fs.writeFileSync(unheld, 'left by a crash', { mode: 0o600 });
      abandoned.lock.release();
      try {
        const registered = leftoverDirectories(paths).filter((entry) => entry.directory === directory);
        expect(registered).toHaveLength(1);
        await sweepLeftovers({ directories: registered, lock, files: { readdir: (dir) => fs.promises.readdir(dir), rm: (file) => fs.promises.rm(file, { recursive: true, force: true }) } });
        expect(fs.existsSync(held)).toBe(true);
        expect(fs.readdirSync(directory).filter((name) => name.startsWith(path.basename(unheld)))).toEqual([]);
      } finally {
        holding.lock.release();
      }
    });
  }
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

  it('registers run/ for the temporaries of its atomic writes, and never names run/current, the counter, a lock or a generation directory (20.66)', () => {
    const paths = momongaPaths(makeTemporaryDirectory());
    const run = leftoverDirectories(paths).find((entry) => entry.directory === paths.run);
    expect(run?.isLeftover('.current.0a1b2c.tmp')).toBe(true);
    expect(run?.isLeftover('.generation.counter.0a1b2c.tmp')).toBe(true);
    for (const name of ['current', 'generation.counter', 'generation.lock', 'g1', 'markers', 'call-locks']) expect(run?.isLeftover(name), name).toBe(false);
  });
});

describe('S8: every directory the product writes entries in is swept, including the store blobs and the probe records', () => {
  const blobsOf = (paths: ReturnType<typeof momongaPaths>): string => path.join(path.dirname(paths.databases.runtime), 'blobs');

  it('registers the store blobs directory and the probe record directory', () => {
    const paths = momongaPaths(makeTemporaryDirectory());
    const registered = leftoverDirectories(paths).map((entry) => entry.directory);
    expect(registered).toEqual(expect.arrayContaining([blobsOf(paths), paths.probe]));
  });

  for (const platform of ['darwin', 'linux'] as const) {
    it(`${platform} mechanism: one sweep removes a crashed blob temporary with its sidecar and keeps a held one`, async () => {
      const lock = expectedKernelLockOn(platform);
      const paths = momongaPaths(makeTemporaryDirectory());
      const blobs = blobsOf(paths);
      fs.mkdirSync(blobs, { recursive: true, mode: 0o700 });
      const sha = 'ab'.repeat(32);
      const crashed = path.join(blobs, `.${sha}.0a1b2c3d4e5f.tmp`);
      const inFlight = path.join(blobs, `.${sha}.f5e4d3c2b1a0.tmp`);
      const abandoned = await lock.claim(crashed);
      if (abandoned.kind !== 'claimed') throw new Error(`${crashed} could not be claimed by the test`);
      fs.writeFileSync(crashed, 'partial blob', { mode: 0o600 });
      abandoned.lock.release();
      const holding = await lock.claim(inFlight);
      if (holding.kind !== 'claimed') throw new Error(`${inFlight} could not be claimed by the test`);
      fs.writeFileSync(inFlight, 'blob being written', { mode: 0o600 });
      try {
        const registered = leftoverDirectories(paths).filter((entry) => entry.directory === blobs);
        expect(registered).toHaveLength(1);
        await sweepLeftovers({ directories: registered, lock, files: { readdir: (dir) => fs.promises.readdir(dir), rm: (file) => fs.promises.rm(file, { recursive: true, force: true }) } });
        expect(fs.readdirSync(blobs).filter((name) => name.startsWith(path.basename(crashed)))).toEqual([]);
        expect(fs.existsSync(inFlight)).toBe(true);
      } finally {
        holding.lock.release();
      }
    });
  }
});
