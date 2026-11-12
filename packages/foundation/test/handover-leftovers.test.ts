import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  handoverDirectoryOf,
  handoverLeftovers,
  handoverRecordFields,
  handoverRecordOwner,
  isProcessAlive,
  leftoverDirectories,
  momongaPaths,
  nodeFileSystem,
  pidNamespaceOf,
  reapDeadGenerations,
  sidecarOf,
  sweepLeftovers,
} from '@momonga/foundation';
import type { FileSystem, KernelLockMechanism, MomongaPaths } from '@momonga/foundation';
import { handoverRecordReader } from '../src/handover-leftovers.ts';
import { claimNewEntry } from '../src/platform/lock-form.ts';
import type { HandoverLeftoverPorts } from '../src/handover-leftovers.ts';
import { makeTemporaryDirectory } from './support/temporary-directory.ts';
import { expectedKernelLockOn, testKernelLock } from '@momonga/testkit';

const PID_NO_PROCESS_HAS = 99_999_999;
const OTHER_NAMESPACE = 'pid:[4026500001]';

const here = await pidNamespaceOf(nodeFileSystem);

const hostPorts: HandoverLeftoverPorts = { files: nodeFileSystem, namespace: here, alive: (pid) => isProcessAlive(pid) };

type Parties = { writer: number; reader: number; namespace: string };

const recordText = (parties: Parties): string => JSON.stringify({ format: 'handover/1', session: 'session-1', ...handoverRecordFields(parties) });

const partiesOf = (writer: number, reader: number, namespace: string = here): Parties => ({ writer, reader, namespace });

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

const sweep = (lock: KernelLockMechanism, paths: MomongaPaths, ports: HandoverLeftoverPorts = hostPorts, warn?: (message: string) => void) =>
  sweepLeftovers({ directories: [handoverLeftovers(paths, ports)], lock, ...(warn === undefined ? {} : { warn }) });

describe('16.8: the leftover sweep of the handover records', () => {
  it('writes the writer, the reader and the namespace of the reader, and reads them back', () => {
    const text = recordText(partiesOf(4242, 4343, OTHER_NAMESPACE));
    expect(handoverRecordOwner(text)).toBe(4242);
    expect(handoverRecordReader(text)).toEqual({ pid: 4343, namespace: OTHER_NAMESPACE });
  });

  it('reads no reader from a record that names no reader pid or no namespace', () => {
    for (const text of [
      JSON.stringify({ pid: 4242 }),
      JSON.stringify({ pid: 4242, reader: 4343 }),
      JSON.stringify({ pid: 4242, namespace: here }),
      JSON.stringify({ pid: 4242, reader: '4343', namespace: here }),
      JSON.stringify({ pid: 4242, reader: 0, namespace: here }),
      JSON.stringify({ pid: 4242, reader: 4343, namespace: '' }),
      'not json',
      '[]',
    ])
      expect(handoverRecordReader(text), text).toBeUndefined();
  });

  it('is registered in the list of leftover directories, once', () => {
    const { paths, directory } = siteOf();
    expect(leftoverDirectories(paths, hostPorts).filter((registered) => registered.directory === directory)).toHaveLength(1);
  });

  it('names the records and the temporaries of their atomic writes', () => {
    const registered = handoverLeftovers(siteOf().paths, hostPorts);
    expect(registered.isLeftover('session-1.json')).toBe(true);
    expect(registered.isLeftover('.session-1.json.0a1b2c.tmp')).toBe(true);
    expect(registered.isLeftover('notes.txt')).toBe(false);
  });

  for (const platform of ['darwin', 'linux'] as const) {
    describe(`${platform} mechanism`, () => {
      const lock = expectedKernelLockOn(platform);

      it('keeps a record whose writer holds its lock, even when the reader in it names no process', async () => {
        const { paths, directory, record } = siteOf();
        const held = await claimNewEntry(lock, record, 'sidecar');
        fs.writeFileSync(record, recordText(partiesOf(PID_NO_PROCESS_HAS, PID_NO_PROCESS_HAS)), { mode: 0o600 });
        try {
          const swept = await sweep(lock, paths);
          expect(swept.removed).toEqual([]);
          expect(fs.existsSync(record)).toBe(true);
          expect(fs.readdirSync(directory).length).toBeGreaterThan(1);
        } finally {
          held.release();
        }
      });

      it('keeps a record nobody holds whose writer is gone while the reader it names lives (a relay parent killed after the spawn)', async () => {
        const { paths, record } = siteOf();
        const text = recordText(partiesOf(PID_NO_PROCESS_HAS, process.pid));
        await leaveRecord(lock, record, text);
        const swept = await sweep(lock, paths);
        expect(swept.removed).toEqual([]);
        expect(fs.readFileSync(record, 'utf8')).toBe(text);
        expect(fs.existsSync(sidecarOf(lock, record))).toBe(true);
      });

      it('removes a record nobody holds whose reader is gone, with its lock file, even while its writer lives', async () => {
        const { paths, directory, record } = siteOf();
        await leaveRecord(lock, record, recordText(partiesOf(process.pid, PID_NO_PROCESS_HAS)));
        const swept = await sweep(lock, paths);
        expect(swept.removed).toEqual([record]);
        expect(fs.readdirSync(directory)).toEqual([]);
      });

      it('keeps a record whose reader is in another pid namespace without probing it, and says so', async () => {
        const { paths, record } = siteOf();
        const probed: number[] = [];
        const warnings: string[] = [];
        await leaveRecord(lock, record, recordText(partiesOf(PID_NO_PROCESS_HAS, PID_NO_PROCESS_HAS, OTHER_NAMESPACE)));
        const swept = await sweep(lock, paths, { ...hostPorts, alive: (pid) => (probed.push(pid), false) }, (message) => warnings.push(message));
        expect(swept).toEqual({ removed: [], kept: [record] });
        expect(probed).toEqual([]);
        expect(fs.existsSync(record)).toBe(true);
        expect(warnings).toEqual([expect.stringContaining(record)]);
        expect(warnings[0]).toContain(OTHER_NAMESPACE);
      });

      it('removes a record nobody holds that names no reader', async () => {
        const { paths, directory, record } = siteOf();
        await leaveRecord(lock, record, JSON.stringify({ format: 'handover/1', pid: process.pid }));
        await sweep(lock, paths);
        expect(fs.readdirSync(directory)).toEqual([]);
      });

      it('removes a record nobody holds that is not JSON', async () => {
        const { paths, directory, record } = siteOf();
        await leaveRecord(lock, record, 'not json');
        await sweep(lock, paths);
        expect(fs.readdirSync(directory)).toEqual([]);
      });

      it('removes the lock file an adopted record left behind', async () => {
        const { paths, directory, record } = siteOf();
        await leaveRecord(lock, record, recordText(partiesOf(process.pid, process.pid)));
        fs.rmSync(record);
        await sweep(lock, paths);
        expect(fs.readdirSync(directory)).toEqual([]);
      });

      it('reports a record it cannot read with its path and code, keeps it, and goes on with the others', async () => {
        const { paths, directory, record } = siteOf();
        const other = path.join(directory, 'session-2.json');
        await leaveRecord(lock, record, recordText(partiesOf(PID_NO_PROCESS_HAS, PID_NO_PROCESS_HAS)));
        await leaveRecord(lock, other, recordText(partiesOf(PID_NO_PROCESS_HAS, PID_NO_PROCESS_HAS)));
        const denying: Pick<FileSystem, 'openRead'> = {
          openRead: (file, flags) => (file === record ? Promise.reject(Object.assign(new Error(`EACCES: permission denied, open '${file}'`), { code: 'EACCES' })) : nodeFileSystem.openRead(file, flags)),
        };
        const warnings: string[] = [];
        const swept = await sweep(lock, paths, { ...hostPorts, files: denying }, (message) => warnings.push(message));
        expect(swept).toEqual({ removed: [other], kept: [record] });
        expect(warnings).toEqual([expect.stringContaining(record)]);
        expect(warnings[0]).toContain('EACCES');
        expect(fs.existsSync(record)).toBe(true);
        expect(fs.existsSync(sidecarOf(lock, record))).toBe(true);
        const again = await sweep(lock, paths);
        expect(again.removed).toEqual([record]);
      });
    });
  }

  it('is swept with the whole registered list, as the gateway start sweeps it, and never by the pass that reaps the dead generations (T-L2-11)', async () => {
    const { paths, record } = siteOf();
    const lock = testKernelLock();
    await leaveRecord(lock, record, recordText(partiesOf(PID_NO_PROCESS_HAS, PID_NO_PROCESS_HAS)));
    await reapDeadGenerations({ paths, lock, signal: new AbortController().signal, warn: () => undefined, reapMarkers: async () => undefined });
    expect(fs.existsSync(record)).toBe(true);
    await sweepLeftovers({ directories: leftoverDirectories(paths, hostPorts), lock });
    expect(fs.existsSync(record)).toBe(false);
  });
});
