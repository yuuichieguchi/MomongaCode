import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBinaryHashCache, createHeldHostReadings, readProbeKeyComponents } from '@momonga/foundation';
import type { FileSystem, HostExec, HostExecAnswer, ReadHandle } from '@momonga/foundation';
import { createTempDir } from '@momonga/testkit';

const directories: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

const binaryFile = (): string => {
  const directory = createTempDir();
  directories.push(directory);
  const file = path.join(directory, 'binary');
  fs.writeFileSync(file, 'on disk');
  return file;
};

type HeldRead = { push(text: string | null): void; destroyed: boolean };

type HeldStreams = { files: Pick<FileSystem, 'stat' | 'openRead'>; streams: HeldRead[]; statsSettled(): number };

const holdTheReads = (): HeldStreams => {
  const streams: HeldRead[] = [];
  let settled = 0;
  const realStat = fs.promises.stat.bind(fs.promises);
  const files: Pick<FileSystem, 'stat' | 'openRead'> = {
    stat: async (file) => {
      try {
        return await realStat(file);
      } finally {
        settled += 1;
      }
    },
    openRead: async () => {
      const waiting: Array<(chunk: Buffer | null) => void> = [];
      const queued: Array<Buffer | null> = [];
      const read: HeldRead = {
        destroyed: false,
        push: (text) => {
          const chunk = text === null ? null : Buffer.from(text);
          const resolve = waiting.shift();
          if (resolve !== undefined) resolve(chunk);
          else queued.push(chunk);
        },
      };
      streams.push(read);
      const handle: ReadHandle = {
        stat: () => Promise.reject(new Error('the held read has no stat')),
        chmod: () => Promise.reject(new Error('the held read has no chmod')),
        read: async (page) => {
          const chunk = queued.length > 0 ? (queued.shift() as Buffer | null) : await new Promise<Buffer | null>((resolve) => waiting.push(resolve));
          if (chunk === null) return 0;
          return chunk.copy(page);
        },
        readAt: () => Promise.reject(new Error('the held read has no positional read')),
        close: async () => {
          read.destroyed = true;
        },
      };
      return handle;
    },
  };
  return { files, streams, statsSettled: () => settled };
};

const outcomeOf = (promise: Promise<unknown>): Promise<{ value: unknown } | { error: unknown }> =>
  promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );

const CONTENT = 'the bytes of the binary';
const DIGEST = createHash('sha256').update(CONTENT).digest('hex');

describe('the shared hash of one binary belongs to no single asker', () => {
  it('gives the second asker the digest of the one read after the first asker left', async () => {
    const file = binaryFile();
    const held = holdTheReads();
    const cache = createBinaryHashCache(held.files);
    const first = new AbortController();
    const second = new AbortController();
    const leftBecause = new Error('the first asker left');

    const firstOutcome = outcomeOf(cache.sha256Of(file, first.signal));
    const secondOutcome = outcomeOf(cache.sha256Of(file, second.signal));
    await vi.waitFor(() => expect(held.statsSettled()).toBe(2));
    await vi.waitFor(() => expect(held.streams).toHaveLength(1));
    first.abort(leftBecause);

    expect(await firstOutcome).toEqual({ error: leftBecause });
    held.streams[0]?.push(CONTENT);
    held.streams[0]?.push(null);
    expect(await secondOutcome).toEqual({ value: DIGEST });
    expect(held.streams).toHaveLength(1);
  });

  it('runs the read to completion after its only asker left, and gives the next asker that digest without a second read', async () => {
    const file = binaryFile();
    const held = holdTheReads();
    const cache = createBinaryHashCache(held.files);
    const only = new AbortController();
    const left = new Error('the only asker left');

    const onlyOutcome = outcomeOf(cache.sha256Of(file, only.signal));
    await vi.waitFor(() => expect(held.streams).toHaveLength(1));
    only.abort(left);

    expect(await onlyOutcome).toEqual({ error: left });
    expect(held.streams[0]?.destroyed).toBe(false);
    held.streams[0]?.push(CONTENT);
    held.streams[0]?.push(null);
    expect(await cache.sha256Of(file, new AbortController().signal)).toBe(DIGEST);
    expect(held.streams).toHaveLength(1);
  });
});

describe('the held OS build reading belongs to no single asker', () => {
  const heldExec = (): { exec: HostExec; calls: AbortSignal[]; answer(build: string): void } => {
    const calls: AbortSignal[] = [];
    const answers: ((answer: HostExecAnswer) => void)[] = [];
    return {
      calls,
      exec: (_file, _args, options) =>
        new Promise<HostExecAnswer>((resolve) => {
          calls.push(options.signal);
          answers.push(resolve);
        }),
      answer: (build) => {
        for (const resolve of answers) resolve({ exitCode: 0, stdout: `${build}\n`, stderr: '' });
      },
    };
  };

  const readOsBuild = (exec: HostExec, host: ReturnType<typeof createHeldHostReadings>, signal: AbortSignal) =>
    readProbeKeyComponents({ identity: ['hostOsBuild'], binary: '/unused', platform: 'darwin', exec, signal, host });

  it('gives the second asker the reading of the one exec after the first asker left', async () => {
    const fake = heldExec();
    const host = createHeldHostReadings();
    const first = new AbortController();
    const leftBecause = new Error('the first asker left');

    const firstOutcome = outcomeOf(readOsBuild(fake.exec, host, first.signal));
    const secondOutcome = outcomeOf(readOsBuild(fake.exec, host, new AbortController().signal));
    first.abort(leftBecause);

    expect(await firstOutcome).toEqual({ error: leftBecause });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.aborted).toBe(false);
    fake.answer('25A1');
    expect(await secondOutcome).toEqual({ value: { hostOsBuild: { kind: 'read', value: '25A1' } } });
  });

  it('runs the exec to completion after its only asker left, and gives the next asker that reading without a second exec', async () => {
    const fake = heldExec();
    const host = createHeldHostReadings();
    const only = new AbortController();
    const leftBecause = new Error('the only asker left');

    const outcome = outcomeOf(readOsBuild(fake.exec, host, only.signal));
    only.abort(leftBecause);

    expect(await outcome).toEqual({ error: leftBecause });
    expect(fake.calls[0]?.aborted).toBe(false);
    fake.answer('25A1');
    expect(await readOsBuild(fake.exec, host, new AbortController().signal)).toEqual({ hostOsBuild: { kind: 'read', value: '25A1' } });
    expect(fake.calls).toHaveLength(1);
  });
});
