import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { nodeEntryIo } from '@momonga/foundation';
import { withTempDir } from '@momonga/testkit';

type Record = { [key: string]: unknown; msg: string };

const fakeStream = () => {
  const written: string[] = [];
  const stream = Object.assign(new EventEmitter(), {
    written,
    write: (chunk: string, callback?: () => void): boolean => {
      written.push(chunk);
      callback?.();
      return true;
    },
  });
  return stream;
};

const fakeHost = () => {
  const stdout = fakeStream();
  const stderr = fakeStream();
  const host = Object.assign(new EventEmitter(), {
    argv: ['/usr/bin/node', '/app/bin.ts'],
    env: { HOME: '/Users/host' } as { [key: string]: string | undefined },
    stdout,
    stderr,
    exit: (): void => undefined,
    exitCode: undefined as number | undefined,
    pid: 4242,
  });
  return { stdout, stderr, asProcess: host as unknown as NodeJS.Process };
};

const errnoError = (code: string): NodeJS.ErrnoException => Object.assign(new Error(`write ${code}`), { code });

const records = (file: string): Record[] =>
  fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Record);

const streamRecords = (file: string): Record[] => records(file).filter((record) => 'stream' in record);

const openLog = (context: Parameters<typeof withTempDir>[0]) => {
  const file = path.join(withTempDir(context), 'logs', 'runtime.log');
  fs.mkdirSync(path.dirname(file), { mode: 0o700 });
  const host = fakeHost();
  const io = nodeEntryIo(host.asProcess);
  const log = io.logFile(file);
  return { file, host, log };
};

describe('nodeEntryIo: errors on its own standard streams (11.3)', () => {
  it('an EPIPE on stdout is one stdio.closed record in the log file and no crash', (context) => {
    const { file, host, log } = openLog(context);
    expect(() => host.stdout.emit('error', errnoError('EPIPE'))).not.toThrow();
    log.close();
    expect(streamRecords(file)).toEqual([expect.objectContaining({ msg: 'stdio.closed', stream: 'stdout', code: 'EPIPE' })]);
  });

  it('an EIO on stdout is one write-failure record naming stdout, its code and its message', (context) => {
    const { file, host, log } = openLog(context);
    host.stdout.emit('error', errnoError('EIO'));
    log.close();
    expect(streamRecords(file)).toEqual([expect.objectContaining({ msg: 'logs.write_failed', stream: 'stdout', code: 'EIO', message: 'write EIO' })]);
  });

  it('repeated errors of one stream and code inside the interval give one record', (context) => {
    const { file, host, log } = openLog(context);
    host.stdout.emit('error', errnoError('EIO'));
    host.stdout.emit('error', errnoError('EIO'));
    host.stdout.emit('error', errnoError('EIO'));
    log.close();
    expect(streamRecords(file)).toHaveLength(1);
  });

  it('rate-limits per stream and code, so another code or another stream is its own record', (context) => {
    const { file, host, log } = openLog(context);
    host.stdout.emit('error', errnoError('EIO'));
    host.stdout.emit('error', errnoError('ENOSPC'));
    host.stderr.emit('error', errnoError('EIO'));
    log.close();
    expect(streamRecords(file).map((record) => [record['stream'], record['code']])).toEqual([
      ['stdout', 'EIO'],
      ['stdout', 'ENOSPC'],
      ['stderr', 'EIO'],
    ]);
  });

  it('an error on stderr is recorded in the log file and never written to stderr', (context) => {
    const { file, host, log } = openLog(context);
    host.stderr.emit('error', errnoError('EIO'));
    log.close();
    expect(streamRecords(file)).toEqual([expect.objectContaining({ stream: 'stderr', code: 'EIO' })]);
    expect(host.stderr.written).toEqual([]);
  });

  it('an EPIPE is reported once however often the closed stream fails again', (context) => {
    const { file, host, log } = openLog(context);
    host.stdout.emit('error', errnoError('EPIPE'));
    host.stdout.emit('error', errnoError('EPIPE'));
    log.close();
    expect(streamRecords(file).filter((record) => record.msg === 'stdio.closed')).toHaveLength(1);
  });
});

describe('nodeEntryIo: the throttle of its write-failure records reads the given clock port', () => {
  const steppedTiming = () => {
    const at = { wall: Date.UTC(2026, 10, 18), monotonic: 0 };
    return { at, timing: { now: () => at.wall, monotonicMs: () => at.monotonic } };
  };

  const openLogWith = (context: Parameters<typeof withTempDir>[0], timing: { now: () => number; monotonicMs: () => number }) => {
    const file = path.join(withTempDir(context), 'logs', 'runtime.log');
    fs.mkdirSync(path.dirname(file), { mode: 0o700 });
    const host = fakeHost();
    const io = nodeEntryIo(host.asProcess, undefined, timing);
    return { file, host, log: io.logFile(file) };
  };

  it('stamps a record with the wall time of the port', (context) => {
    const { at, timing } = steppedTiming();
    const { file, host, log } = openLogWith(context, timing);
    host.stdout.emit('error', errnoError('EIO'));
    log.close();
    expect(streamRecords(file).map((record) => record['ts'])).toEqual([new Date(at.wall).toISOString()]);
  });

  it('opens the interval again when the monotonic reading passes a minute, whatever the wall clock does', (context) => {
    const { at, timing } = steppedTiming();
    const { file, host, log } = openLogWith(context, timing);
    host.stdout.emit('error', errnoError('EIO'));
    at.wall -= 3_600_000;
    at.monotonic += 60_000;
    host.stdout.emit('error', errnoError('EIO'));
    log.close();
    expect(streamRecords(file)).toHaveLength(2);
  });

  it('keeps the interval closed while the monotonic reading stays inside a minute, though the wall clock jumps ahead', (context) => {
    const { at, timing } = steppedTiming();
    const { file, host, log } = openLogWith(context, timing);
    host.stdout.emit('error', errnoError('EIO'));
    at.wall += 3_600_000;
    at.monotonic += 59_999;
    host.stdout.emit('error', errnoError('EIO'));
    log.close();
    expect(streamRecords(file)).toHaveLength(1);
  });
});
