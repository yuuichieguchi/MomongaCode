import { EventEmitter } from 'node:events';
import path from 'node:path';
import { spawn } from '@momonga/testkit/child-process';
import { EXIT_OK, HELPER_COMMAND, guardStandardStreams } from '@momonga/foundation';
import { createTempDir, removeTempDir, systemTempRoot } from '@momonga/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const PRODUCT_ENTRY = path.resolve(import.meta.dirname, '..', 'src', 'main.ts');
const FLOODING_ENTRY = path.resolve(import.meta.dirname, 'broken-pipe-entry.ts');
const CHILD_TIMEOUT_MS = 60_000;

let home = '';

beforeAll(() => {
  home = createTempDir({ asHome: true });
});

afterAll(async () => {
  await removeTempDir(home);
});

type Ended = { code: number | null; signal: NodeJS.Signals | null; stderr: string };

const endedWithoutReader = (args: readonly string[], closeAfterFirstBytes: boolean): Promise<Ended> =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { env: { PATH: process.env['PATH'] ?? '', HOME: home, TMPDIR: systemTempRoot() }, timeout: CHILD_TIMEOUT_MS });
    const stderr: Buffer[] = [];
    if (closeAfterFirstBytes) child.stdout.once('data', () => child.stdout.destroy());
    else child.stdout.destroy();
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stderr: Buffer.concat(stderr).toString('utf8') }));
    child.stdin.end();
  });

describe('a command whose standard output has no reader any more', { timeout: CHILD_TIMEOUT_MS * 2 }, () => {
  it('ends with its own exit code and no uncaught exception when the reader left after the first bytes, as head -1 does', async () => {
    const ended = await endedWithoutReader([FLOODING_ENTRY, HELPER_COMMAND, 'flood'], true);

    expect(ended.stderr).toBe('the command reached its end\n');
    expect(ended).toMatchObject({ code: 7, signal: null });
  });

  it('ends with its own exit code when the reader had left before the first byte: momonga --help', async () => {
    const ended = await endedWithoutReader([PRODUCT_ENTRY, '--help'], false);

    expect(ended.stderr).toBe('');
    expect(ended).toMatchObject({ code: EXIT_OK, signal: null });
  });
});

type StandardStream = 'stdout' | 'stderr';

type FakeStream = EventEmitter & { written: string[]; write(chunk: string): boolean };

const fakeStream = (): FakeStream => {
  const written: string[] = [];
  return Object.assign(new EventEmitter(), { written, write: (chunk: string) => written.push(chunk) > 0 });
};

const errorWith = (code: string): NodeJS.ErrnoException => Object.assign(new Error(`write ${code}`), { code });

describe('the one adapter of the standard streams', () => {
  const guarded = () => {
    const host = { stdout: fakeStream(), stderr: fakeStream() };
    const closed: StandardStream[] = [];
    const failed: string[] = [];
    const streams = guardStandardStreams(host as unknown as Pick<NodeJS.Process, 'stdout' | 'stderr'>);
    streams.observe({ closed: (stream) => void closed.push(stream), failed: (stream, error) => void failed.push(`${stream}:${String(error.code)}`) });
    return { host, streams, closed, failed };
  };

  it('records the first broken pipe of a stream once and drops every later write to that stream only', () => {
    const { host, streams, closed, failed } = guarded();
    streams.stdout.write('before\n');
    host.stdout.emit('error', errorWith('EPIPE'));
    host.stdout.emit('error', errorWith('EPIPE'));
    streams.stdout.write('after\n');
    streams.stderr.write('still heard\n');

    expect(closed).toEqual(['stdout']);
    expect(failed).toEqual([]);
    expect(streams.isClosed('stdout')).toBe(true);
    expect(streams.isClosed('stderr')).toBe(false);
    expect(host.stdout.written).toEqual(['before\n']);
    expect(host.stderr.written).toEqual(['still heard\n']);
  });

  it('gives every other failure of a stream to the observer and keeps the stream open', () => {
    const { host, streams, closed, failed } = guarded();
    host.stderr.emit('error', errorWith('EIO'));
    streams.stderr.write('after\n');

    expect(closed).toEqual([]);
    expect(failed).toEqual(['stderr:EIO']);
    expect(host.stderr.written).toEqual(['after\n']);
  });

  it('has one observer: the entry that takes the process over replaces the one before it', () => {
    const { host, streams, closed } = guarded();
    const later: StandardStream[] = [];
    streams.observe({ closed: (stream) => void later.push(stream), failed: () => undefined });
    host.stderr.emit('error', errorWith('EPIPE'));

    expect(closed).toEqual([]);
    expect(later).toEqual(['stderr']);
    expect(host.stderr.listenerCount('error')).toBe(1);
  });

  it('lets a failure that is not a broken pipe end the process when no entry observes the streams', () => {
    const host = { stdout: fakeStream(), stderr: fakeStream() };
    guardStandardStreams(host as unknown as Pick<NodeJS.Process, 'stdout' | 'stderr'>);

    expect(() => host.stdout.emit('error', errorWith('EIO'))).toThrow('write EIO');
    expect(() => host.stdout.emit('error', errorWith('EPIPE'))).not.toThrow();
  });
});
