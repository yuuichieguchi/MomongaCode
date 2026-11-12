import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { handoverLeftovers, handoverRecordOwner, isProcessAlive, momongaPaths, nodeFileSystem, pidNamespaceOf, sweepLeftovers } from '@momonga/foundation';
import type { MomongaPaths } from '@momonga/foundation';
import { nodeRecordFiles } from '../../src/node-ports.ts';
import { spawn } from '@momonga/testkit/child-process';
import { createMover } from '../../src/handover/mover.ts';
import { replaceProcess } from '../../src/handover/replace-process.ts';
import type { RelayChild } from '../../src/handover/replace-process.ts';
import { HANDOVER_FORMAT, encodeRecord, parseRecord, recordFileOf } from '../../src/handover/record.ts';
import type { StreamRecord } from '../../src/handover/record.ts';
import { createTempDir, testKernelLock } from '@momonga/testkit';

const RECORD: StreamRecord = { format: HANDOVER_FORMAT, fromVersion: '1.2.3', toVersion: '1.2.4', session: 'session-1', lastSeq: { 'run-1': 4 }, kind: 'attach', runId: 'run-1', output: 'text', verbose: false };
const PID_NO_PROCESS_HAS = 99_999_999;

const recordFiles = nodeRecordFiles(testKernelLock);

const homes: string[] = [];

const pathsOf = (): MomongaPaths => {
  const home = createTempDir();
  homes.push(home);
  return momongaPaths(home, process.platform, process.env);
};

const textOf = (pid: number): string => {
  const encoded = encodeRecord(RECORD, { writer: pid, reader: pid, namespace: 'single' });
  if (encoded.kind !== 'fits') throw new Error('the record of the test does not fit');
  return encoded.text;
};

const sweep = async (paths: MomongaPaths) =>
  sweepLeftovers({ directories: [handoverLeftovers(paths, { files: nodeFileSystem, namespace: await pidNamespaceOf(nodeFileSystem), alive: (pid) => isProcessAlive(pid) })], lock: testKernelLock() });

afterEach(() => {
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

describe('16.8: the record names its owner and is held by its writer', () => {
  it('encodes the pid of the writing process next to the record, and the record reads back unchanged', () => {
    const text = textOf(4242);
    expect(handoverRecordOwner(text)).toBe(4242);
    expect(parseRecord(text)).toEqual({ kind: 'record', record: RECORD });
  });

  it('the mover writes the parties it is given into the record: the writer, the reader and the reader\'s pid namespace', async () => {
    const written: string[] = [];
    const mover = createMover({
      version: '1.2.3',
      parties: async () => ({ writer: 4242, reader: 4343, namespace: 'pid:[4026531836]' }),
      write: (_file, text) => void written.push(text),
      remove: () => undefined,
      handOver: () => undefined,
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
    expect(written.map((text): unknown => JSON.parse(text))).toEqual([expect.objectContaining({ pid: 4242, reader: 4343, namespace: 'pid:[4026531836]' })]);
  });

  it('a written record is kept by the sweep while its writer lives, whatever pid it names, and leaves no temporary', async () => {
    const paths = pathsOf();
    const file = recordFileOf(paths, 'attach', 'session-1');
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
    const file = recordFileOf(paths, 'attach', 'session-1');
    recordFiles.write(file, textOf(1));
    recordFiles.write(file, textOf(2));
    expect(handoverRecordOwner(recordFiles.read(file))).toBe(2);
    recordFiles.remove(file);
  });

  it('the writer that removes its record leaves nothing in the directory', () => {
    const paths = pathsOf();
    const file = recordFileOf(paths, 'attach', 'session-1');
    recordFiles.write(file, textOf(process.pid));
    recordFiles.remove(file);
    expect(fs.readdirSync(path.dirname(file))).toEqual([]);
  });

  it('the adopting process that removes a record it did not write leaves nothing in the directory', async () => {
    const paths = pathsOf();
    const file = recordFileOf(paths, 'attach', 'session-1');
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

describe('a record belongs to one attached client', () => {
  it('a TUI and an attach client of one session each write, read and remove their own record', () => {
    const paths = pathsOf();
    const tui = recordFileOf(paths, 'tui', 'session-1');
    const attach = recordFileOf(paths, 'attach', 'session-1');
    recordFiles.write(tui, textOf(1));
    recordFiles.write(attach, textOf(2));
    expect([handoverRecordOwner(recordFiles.read(tui)), handoverRecordOwner(recordFiles.read(attach))]).toEqual([1, 2]);
    recordFiles.remove(tui);
    expect(handoverRecordOwner(recordFiles.read(attach))).toBe(2);
    recordFiles.remove(attach);
    expect(fs.readdirSync(path.dirname(tui))).toEqual([]);
  });
});

describe('P-323: a relayed record names the child as its reader', () => {
  it('the sweep keeps the record while the relayed child lives, after the relay parent has handed its lock over, and removes it once the child is gone', async () => {
    const paths = pathsOf();
    const file = recordFileOf(paths, 'attach', 'session-1');
    const namespace = await pidNamespaceOf(nodeFileSystem);
    const children: RelayChild[] = [];
    let childPid: number | undefined;
    const spawned = new Promise<void>((resolve) => {
      const mover = createMover({
        version: '1.2.3',
        parties: async () => ({ writer: process.pid, reader: process.pid, namespace }),
        write: recordFiles.write,
        remove: recordFiles.remove,
        handOver: (handed) => {
          recordFiles.handOver(handed);
          resolve();
        },
        target: () => ({ file: process.execPath, args: ['-e', 'setInterval(() => undefined, 1000)'], env: {} }),
        replace: (target, hooks) =>
          replaceProcess(
            target,
            {
              execve: undefined,
              spawn: (command, args) => {
                const child = spawn(command, args, { stdio: 'ignore' });
                childPid = child.pid;
                children.push(child);
                return child;
              },
              exit: () => undefined,
              onSignal: () => undefined,
            },
            hooks,
          ),
      });
      mover.attach({
        surface: 'cli',
        kept: () => ({ kind: 'run', runId: RECORD.runId }),
        recordFile: () => file,
        quiet: () => true,
        snapshot: () => RECORD,
        terminal: () => undefined,
        suspend: async () => undefined,
        release: () => undefined,
        resume: () => undefined,
        say: () => undefined,
      });
      void mover.learned('1.2.4');
    });
    await spawned;
    const child = children[0];
    if (child === undefined || childPid === undefined) throw new Error('the relay started no child');
    const ended = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    try {
      expect(JSON.parse(recordFiles.read(file))).toMatchObject({ pid: process.pid, reader: childPid, namespace });
      expect((await sweep(paths)).removed).toEqual([]);
      expect(fs.existsSync(file)).toBe(true);
    } finally {
      child.kill('SIGKILL');
      await ended;
    }
    expect((await sweep(paths)).removed).toEqual([file]);
  });
});
