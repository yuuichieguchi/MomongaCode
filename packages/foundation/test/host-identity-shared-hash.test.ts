import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBinaryHashCache, createHeldHostReadings, readProbeKeyComponents } from '@momonga/foundation';
import type { HostExec, HostExecAnswer } from '@momonga/foundation';

const directories: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

const binaryFile = (): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-shared-hash-'));
  directories.push(directory);
  const file = path.join(directory, 'binary');
  fs.writeFileSync(file, 'on disk');
  return file;
};

type HeldStreams = { streams: Readable[]; statsSettled(): number };

const holdTheReads = (): HeldStreams => {
  const streams: Readable[] = [];
  let settled = 0;
  const realStat = fs.promises.stat.bind(fs.promises);
  vi.spyOn(fs.promises, 'stat').mockImplementation((async (file: fs.PathLike) => {
    try {
      return await realStat(file);
    } finally {
      settled += 1;
    }
  }) as typeof fs.promises.stat);
  vi.spyOn(fs, 'createReadStream').mockImplementation((() => {
    const stream = new Readable({ read: () => undefined });
    streams.push(stream);
    return stream;
  }) as unknown as typeof fs.createReadStream);
  return { streams, statsSettled: () => settled };
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
    const cache = createBinaryHashCache();
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

  it('ends the read when its last asker leaves, and reads again for the next asker', async () => {
    const file = binaryFile();
    const held = holdTheReads();
    const cache = createBinaryHashCache();
    const first = new AbortController();
    const second = new AbortController();
    const firstLeft = new Error('the first asker left');
    const secondLeft = new Error('the second asker left');

    const firstOutcome = outcomeOf(cache.sha256Of(file, first.signal));
    const secondOutcome = outcomeOf(cache.sha256Of(file, second.signal));
    await vi.waitFor(() => expect(held.statsSettled()).toBe(2));
    await vi.waitFor(() => expect(held.streams).toHaveLength(1));
    first.abort(firstLeft);
    expect(held.streams[0]?.destroyed).toBe(false);
    second.abort(secondLeft);

    expect(await firstOutcome).toEqual({ error: firstLeft });
    expect(await secondOutcome).toEqual({ error: secondLeft });
    await vi.waitFor(() => expect(held.streams[0]?.destroyed).toBe(true));

    const third = outcomeOf(cache.sha256Of(file, new AbortController().signal));
    await vi.waitFor(() => expect(held.streams).toHaveLength(2));
    held.streams[1]?.push(CONTENT);
    held.streams[1]?.push(null);
    expect(await third).toEqual({ value: DIGEST });
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

  it('ends the exec when its last asker leaves, and runs it again for the next asker', async () => {
    const fake = heldExec();
    const host = createHeldHostReadings();
    const only = new AbortController();
    const leftBecause = new Error('the only asker left');

    const outcome = outcomeOf(readOsBuild(fake.exec, host, only.signal));
    only.abort(leftBecause);

    expect(await outcome).toEqual({ error: leftBecause });
    expect(fake.calls[0]?.aborted).toBe(true);
    const next = outcomeOf(readOsBuild(fake.exec, host, new AbortController().signal));
    await vi.waitFor(() => expect(fake.calls).toHaveLength(2));
    fake.answer('25A1');
    expect(await next).toEqual({ value: { hostOsBuild: { kind: 'read', value: '25A1' } } });
  });
});
