import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { claimNewEntrySync, EntryLockHeldError, momongaPaths } from '@momonga/foundation';
import { testKernelLock } from '@momonga/testkit';
import { nodeRecordFiles } from '../../src/node-ports.ts';
import { HANDOVER_FORMAT, encodeRecord, recordFileOf } from '../../src/handover/record.ts';

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

const fileOfFreshHome = (): string => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'momonga-node-ports-'));
  homes.push(home);
  return recordFileOf(momongaPaths(home, process.platform, process.env), 'tui', 'session-1');
};

const TEXT = (() => {
  const encoded = encodeRecord({ format: HANDOVER_FORMAT, fromVersion: '1.2.3', toVersion: '1.2.4', session: 'session-1', lastSeq: {}, kind: 'attach', runId: 'run-1', output: 'text', verbose: false }, process.pid);
  if (encoded.kind !== 'fits') throw new Error('the record of the test does not fit');
  return encoded.text;
})();

describe('the relay hands the hold of the record to the process it starts', () => {
  it('while the writer holds its record, no other claim of it succeeds', () => {
    const file = fileOfFreshHome();
    const writer = nodeRecordFiles(testKernelLock);
    writer.write(file, TEXT);
    expect(() => claimNewEntrySync(testKernelLock(), file, 'sidecar')).toThrow(EntryLockHeldError);
    writer.remove(file);
  });

  it('after the hand-over the adopting process claims the record, removes it, and no sidecar remains', () => {
    const file = fileOfFreshHome();
    const writer = nodeRecordFiles(testKernelLock);
    writer.write(file, TEXT);
    writer.handOver(file);
    const adopter = claimNewEntrySync(testKernelLock(), file, 'sidecar');
    fs.rmSync(file);
    adopter.dispose();
    expect(fs.readdirSync(path.dirname(file))).toEqual([]);
  });

  it('a removal after the hand-over by the writer itself claims the record again and leaves nothing', () => {
    const file = fileOfFreshHome();
    const writer = nodeRecordFiles(testKernelLock);
    writer.write(file, TEXT);
    writer.handOver(file);
    writer.remove(file);
    expect(fs.readdirSync(path.dirname(file))).toEqual([]);
  });
});
