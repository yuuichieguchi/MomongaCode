import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  claimNewEntry,
  handoverDirectoryOf,
  handoverLeftovers,
  handoverRecordOwner,
  leftoverDirectories,
  momongaPaths,
  reapDeadGenerations,
  sidecarOf,
  sweepLeftovers,
} from '@momonga/foundation';
import type { KernelLockMechanism, MomongaPaths } from '@momonga/foundation';
import { makeTemporaryDirectory } from './support/temporary-directory.ts';
import { expectedKernelLockOn, testKernelLock } from '@momonga/testkit';

const PID_NO_PROCESS_HAS = 99_999_999;

const recordText = (pid: unknown): string => JSON.stringify({ format: 'handover/1', session: 'session-1', pid });

type Site = { paths: MomongaPaths; directory: string; record: string };

const siteOf = (): Site => {
  const paths = momongaPaths(makeTemporaryDirectory(), process.platform, process.env);
  const directory = handoverDirectoryOf(paths);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  return { paths, directory, record: path.join(directory, 'session-1.json') };
};

const leaveRecord = async (lock: KernelLockMechanism, record: string, text: string): Promise<void> => {
  const held = await claimNewEntry(lock, record, 'sidecar');
  fs.writeFileSync(record, text, { mode: 0o600 });
  held.release();
};

const sweep = (lock: KernelLockMechanism, paths: MomongaPaths) => sweepLeftovers({ directories: [handoverLeftovers(paths)], lock });

describe('16.8: the leftover sweep of the handover records', () => {
  it('reads the owner of a record from its pid field, and gives none for a record without one', () => {
    expect(handoverRecordOwner(recordText(4242))).toBe(4242);
    for (const text of [recordText(undefined), recordText('4242'), recordText(0), recordText(1.5), 'not json', '[]']) expect(handoverRecordOwner(text), text).toBeUndefined();
  });

  it('is registered in the list of leftover directories, once', () => {
    const { paths, directory } = siteOf();
    expect(leftoverDirectories(paths).filter((registered) => registered.directory === directory)).toHaveLength(1);
  });

  it('names the records and the temporaries of their atomic writes', () => {
    const registered = handoverLeftovers(siteOf().paths);
    expect(registered.isLeftover('session-1.json')).toBe(true);
    expect(registered.isLeftover('.session-1.json.0a1b2c.tmp')).toBe(true);
    expect(registered.isLeftover('notes.txt')).toBe(false);
  });

  for (const platform of ['darwin', 'linux'] as const) {
    describe(`${platform} mechanism`, () => {
      const lock = expectedKernelLockOn(platform);

      it('keeps a record whose writer holds its lock, even when the pid in it names no process', async () => {
        const { paths, directory, record } = siteOf();
        const held = await claimNewEntry(lock, record, 'sidecar');
        fs.writeFileSync(record, recordText(PID_NO_PROCESS_HAS), { mode: 0o600 });
        try {
          const swept = await sweep(lock, paths);
          expect(swept.removed).toEqual([]);
          expect(fs.existsSync(record)).toBe(true);
          expect(fs.readdirSync(directory).length).toBeGreaterThan(1);
        } finally {
          held.release();
        }
      });

      it('keeps a record nobody holds while the process named in it lives (the exec keeps the pid and drops the lock)', async () => {
        const { paths, record } = siteOf();
        await leaveRecord(lock, record, recordText(process.pid));
        const swept = await sweep(lock, paths);
        expect(swept.removed).toEqual([]);
        expect(fs.readFileSync(record, 'utf8')).toBe(recordText(process.pid));
        expect(fs.existsSync(sidecarOf(lock, record))).toBe(true);
      });

      it('removes a record nobody holds whose process is gone, with its lock file', async () => {
        const { paths, directory, record } = siteOf();
        await leaveRecord(lock, record, recordText(PID_NO_PROCESS_HAS));
        const swept = await sweep(lock, paths);
        expect(swept.removed).toEqual([record]);
        expect(fs.readdirSync(directory)).toEqual([]);
      });

      it('removes a record nobody holds that names no owner', async () => {
        const { paths, directory, record } = siteOf();
        await leaveRecord(lock, record, 'not json');
        await sweep(lock, paths);
        expect(fs.readdirSync(directory)).toEqual([]);
      });

      it('removes the lock file an adopted record left behind', async () => {
        const { paths, directory, record } = siteOf();
        await leaveRecord(lock, record, recordText(process.pid));
        fs.rmSync(record);
        await sweep(lock, paths);
        expect(fs.readdirSync(directory)).toEqual([]);
      });
    });
  }

  it('is swept with the whole registered list, as the gateway start sweeps it, and never by the pass that reaps the dead generations (T-L2-11)', async () => {
    const { paths, record } = siteOf();
    const lock = testKernelLock();
    await leaveRecord(lock, record, recordText(PID_NO_PROCESS_HAS));
    await reapDeadGenerations({ paths, lock, signal: new AbortController().signal, warn: () => undefined, reapMarkers: async () => undefined });
    expect(fs.existsSync(record)).toBe(true);
    await sweepLeftovers({ directories: leftoverDirectories(paths), lock });
    expect(fs.existsSync(record)).toBe(false);
  });
});
