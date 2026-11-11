import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { handoverLeftovers, handoverRecordOwner, momongaPaths, sweepLeftovers } from '@momonga/foundation';
import type { MomongaPaths } from '@momonga/foundation';
import { nodeRecordFiles } from '../../src/node-ports.ts';
import { createMover } from '../../src/handover/mover.ts';
import { HANDOVER_FORMAT, encodeRecord, parseRecord, recordFileOf } from '../../src/handover/record.ts';
import type { StreamRecord } from '../../src/handover/record.ts';
import { testKernelLock } from '@momonga/testkit';

const RECORD: StreamRecord = { format: HANDOVER_FORMAT, fromVersion: '1.2.3', toVersion: '1.2.4', session: 'session-1', lastSeq: { 'run-1': 4 }, kind: 'attach', runId: 'run-1', output: 'text', verbose: false };
const PID_NO_PROCESS_HAS = 99_999_999;

const recordFiles = nodeRecordFiles(testKernelLock);

const homes: string[] = [];

const pathsOf = (): MomongaPaths => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'momonga-record-files-'));
  homes.push(home);
  return momongaPaths(home, process.platform, process.env);
};

const textOf = (pid: number): string => {
  const encoded = encodeRecord(RECORD, pid);
  if (encoded.kind !== 'fits') throw new Error('the record of the test does not fit');
  return encoded.text;
};

const sweep = (paths: MomongaPaths) => sweepLeftovers({ directories: [handoverLeftovers(paths)], lock: testKernelLock() });

afterEach(() => {
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

describe('16.8: the record names its owner and is held by its writer', () => {
  it('encodes the pid of the writing process next to the record, and the record reads back unchanged', () => {
    const text = textOf(4242);
    expect(handoverRecordOwner(text)).toBe(4242);
    expect(parseRecord(text)).toEqual({ kind: 'record', record: RECORD });
  });

  it('the mover writes the pid of its process into the record', async () => {
    const written: string[] = [];
    const mover = createMover({
      version: '1.2.3',
      pid: 4242,
      write: (_file, text) => void written.push(text),
      remove: () => undefined,
      target: (recordFile) => ({ file: '/opt/momonga', args: ['--handover', recordFile], env: {} }),
      replace: () => Promise.reject(new Error('execve EACCES')),
    });
    mover.attach({
      surface: 'cli',
      kept: () => ({ kind: 'run', runId: RECORD.runId }),
      recordFile: () => '/home/u/.momonga/run/handover/session-1.json',
      quiet: () => true,
      snapshot: () => RECORD,
      terminal: () => undefined,
      suspend: async () => undefined,
      release: () => undefined,
      resume: () => undefined,
      say: () => undefined,
    });
    await mover.learned('1.2.4');
    expect(written.map(handoverRecordOwner)).toEqual([4242]);
  });

  it('a written record is kept by the sweep while its writer lives, whatever pid it names, and leaves no temporary', async () => {
    const paths = pathsOf();
    const file = recordFileOf(paths, 'session-1');
    recordFiles.write(file, textOf(PID_NO_PROCESS_HAS));
    try {
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      expect((await sweep(paths)).removed).toEqual([]);
      expect(recordFiles.read(file)).toBe(textOf(PID_NO_PROCESS_HAS));
      expect(fs.readdirSync(path.dirname(file)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    } finally {
      recordFiles.remove(file);
    }
  });

  it('a second write of the same record by the same process replaces it', () => {
    const paths = pathsOf();
    const file = recordFileOf(paths, 'session-1');
    recordFiles.write(file, textOf(1));
    recordFiles.write(file, textOf(2));
    expect(handoverRecordOwner(recordFiles.read(file))).toBe(2);
    recordFiles.remove(file);
  });

  it('the writer that removes its record leaves nothing in the directory', () => {
    const paths = pathsOf();
    const file = recordFileOf(paths, 'session-1');
    recordFiles.write(file, textOf(process.pid));
    recordFiles.remove(file);
    expect(fs.readdirSync(path.dirname(file))).toEqual([]);
  });

  it('the adopting process that removes a record it did not write leaves nothing in the directory', async () => {
    const paths = pathsOf();
    const file = recordFileOf(paths, 'session-1');
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const lock = testKernelLock();
    const outcome = await lock.claim(`${file}.lock`);
    if (outcome.kind !== 'claimed') throw new Error('the test could not claim the lock of the record');
    fs.writeFileSync(file, textOf(process.pid), { mode: 0o600 });
    outcome.lock.release();
    recordFiles.remove(file);
    expect(fs.readdirSync(path.dirname(file))).toEqual([]);
  });
});
