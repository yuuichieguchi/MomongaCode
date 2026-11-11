import { describe, expect, it } from 'vitest';
import { auxvLayoutOf } from '../../src/platform/linux-parsers.ts';
import { createProcessInspector, hostInspectorPorts } from '../../src/platform/process-inspector.ts';
import type { FileIdentity, ProcFs } from '../../src/platform/procfs.ts';
import { fixedCapability } from '../support/probe-fakes.ts';
import { testLocks } from '@momonga/testkit';

const live = () => ({ signal: new AbortController().signal });

const STAT_SLEEP = '12 (sleep) S 4200 12 4200 34816 12 4194304 120 0 0 0 0 0 0 0 20 0 1 0 987654 5517312 189 18446744073709551615 1 1 0 0 0 0 0 0 0 0 0 0 17 3 0 0 0 0 0';
const UID = 1000;
const MARKER: FileIdentity = { dev: 64769n, ino: 777n };

const auxvOf = (pairs: Array<[bigint, bigint]>): Uint8Array => {
  const layout = auxvLayoutOf(process.arch, 'LE');
  const word = layout.wordBytes;
  const buffer = new ArrayBuffer(pairs.length * 2 * word);
  const view = new DataView(buffer);
  pairs.forEach(([type, value], index) => {
    if (word === 8) {
      view.setBigUint64(index * 16, type, true);
      view.setBigUint64(index * 16 + 8, value, true);
    } else {
      view.setUint32(index * 8, Number(type), true);
      view.setUint32(index * 8 + 4, Number(value), true);
    }
  });
  return new Uint8Array(buffer);
};

type FakeEntry = { text?: string; bytes?: Uint8Array; children?: string[]; identity?: FileIdentity; failure?: string };

const errno = (code: string): NodeJS.ErrnoException => Object.assign(new Error(code), { code });

const fakeProcfs = (entries: Record<string, FakeEntry>): ProcFs => {
  const lookup = (file: string): FakeEntry => {
    const entry = entries[file];
    if (entry === undefined) throw errno('ENOENT');
    if (entry.failure !== undefined) throw errno(entry.failure);
    return entry;
  };
  return {
    readText: async (file) => lookup(file).text ?? '',
    readBytes: async (file) => lookup(file).bytes ?? new Uint8Array(),
    list: async (directory) => lookup(directory).children ?? [],
    identityOf: async (file) => lookup(file).identity ?? { dev: 0n, ino: 0n },
    birthMsOf: async () => 0,
  };
};

const BASE: Record<string, FakeEntry> = {
  '/proc/stat': { text: 'cpu  1 2 3 4\nbtime 1700000000\nprocesses 5\n' },
  '/proc/self/auxv': { bytes: auxvOf([[17n, 100n], [0n, 0n]]) },
  '/m/marker': { identity: MARKER },
};

const ownStatus: FakeEntry = { text: `Name:\tsleep\nUid:\t${UID}\t${UID}\t${UID}\t${UID}\n` };

const listingInspector = (entries: Record<string, FakeEntry>) =>
  createProcessInspector('linux', { ...hostInspectorPorts(testLocks().capability), procfs: fakeProcfs({ ...BASE, ...entries }), uid: () => UID, capability: fixedCapability('unenforced') });

describe('T2 listing path: one rule decides the marker state (R1)', () => {
  it('is free only when the listing succeeded, named nobody and reported nothing uninspectable', async () => {
    const inspector = listingInspector({ '/proc': { children: ['10'] }, '/proc/10/fd': { children: ['0'] }, '/proc/10/fd/0': { identity: { dev: 1n, ino: 1n } } });
    expect(await inspector.markerState('/m/marker', live())).toBe('free');
  });

  it('is held when the listing names a holder', async () => {
    const inspector = listingInspector({ '/proc': { children: ['12'] }, '/proc/12/fd': { children: ['3'] }, '/proc/12/fd/3': { identity: MARKER } });
    expect(await inspector.markerState('/m/marker', live())).toBe('held');
  });

  it('is held when the only report for the marker is an uninspectable process, and a later ask that can inspect it names it', async () => {
    const refusing = listingInspector({ '/proc': { children: ['12'] }, '/proc/12/fd': { failure: 'EACCES' }, '/proc/12/status': ownStatus, '/proc/12/stat': { text: STAT_SLEEP } });
    expect(await refusing.markerState('/m/marker', live())).toBe('held');
    const readable = listingInspector({ '/proc': { children: ['12'] }, '/proc/12/fd': { children: ['3'] }, '/proc/12/fd/3': { identity: MARKER }, '/proc/12/stat': { text: STAT_SLEEP } });
    expect(await readable.holdersOf('/m/marker', live())).toEqual({ kind: 'value', value: [12] });
    expect(await readable.markerState('/m/marker', live())).toBe('held');
  });

  it('is unknown when the listing fails', async () => {
    const inspector = listingInspector({ '/proc': { failure: 'EIO' } });
    expect(await inspector.markerState('/m/marker', live())).toBe('unknown');
  });

  it('is unknown when the signal of the caller has already fired', async () => {
    const inspector = listingInspector({ '/proc': { children: ['10'] }, '/proc/10/fd': { children: [] } });
    expect(await inspector.markerState('/m/marker', { signal: AbortSignal.abort() })).toBe('unknown');
  });
});
