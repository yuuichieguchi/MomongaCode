import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { nodeFileSystem, systemRandom } from '@momonga/foundation';
import type { FileSystem, Random } from '@momonga/foundation';
import { blobDirectoryOf, createBlobStore, prepareBlobDirectory } from '@momonga/store';
import { harness, makeStoreDir, rawDb } from './helpers.ts';
import { testKernelLock } from '@momonga/testkit';

type Recorded = { calls: string[]; fileSystem: FileSystem };

const recording = (overrides: Partial<FileSystem> = {}): Recorded => {
  const calls: string[] = [];
  const fileSystem = new Proxy({ ...nodeFileSystem, ...overrides }, {
    get: (target, name, receiver) => {
      const member: unknown = Reflect.get(target, name, receiver);
      if (typeof member !== 'function' || typeof name !== 'string') return member;
      return (...args: unknown[]): unknown => {
        calls.push(name);
        return Reflect.apply(member, target, args);
      };
    },
  });
  return { calls, fileSystem };
};

const countingRandom = (): { random: Random; draws: () => number } => {
  let draws = 0;
  const counted = <Args extends unknown[], Result>(draw: (...args: Args) => Result) => (...args: Args): Result => {
    draws += 1;
    return draw(...args);
  };
  return {
    random: { float: counted(systemRandom.float), bytes: counted(systemRandom.bytes), hex: counted(systemRandom.hex), uuid: counted(systemRandom.uuid) },
    draws: () => draws,
  };
};

const TEXT = 'one\ntwo\nthree éè\n';

describe('the blob store reaches files and random values only through the ports it is given', () => {
  it('prepares the blob directory through the port and answers a promise', async () => {
    const dir = path.join(makeStoreDir(), 'blobs');
    const { calls, fileSystem } = recording();

    const preparing = prepareBlobDirectory(fileSystem, dir);

    expect(preparing).toBeInstanceOf(Promise);
    await preparing;
    expect(calls).toEqual(['mkdir', 'stat']);
    expect((await nodeFileSystem.stat(dir)).mode & 0o777).toBe(0o700);
  });

  it('refuses a blob directory the port reports as readable by others, naming the fix', async () => {
    const dir = path.join(makeStoreDir(), 'blobs');
    const { fileSystem } = recording({ stat: async (file) => Object.assign(await nodeFileSystem.stat(file), { mode: 0o40755 }) });

    await expect(prepareBlobDirectory(fileSystem, dir)).rejects.toThrow(/chmod 700/);
  });

  it('writes a blob with the given random source and reads it back by lines and by bytes through the port', async () => {
    const { dbPath, store, clock } = harness();
    store.close();
    const dir = blobDirectoryOf(dbPath);
    const { calls, fileSystem } = recording();
    const { random, draws } = countingRandom();
    const blobs = createBlobStore(rawDb(dbPath), clock, dir, { lock: testKernelLock(), fileSystem, random });

    const ref = await blobs.put(TEXT, { mediaType: 'text/plain' });

    expect(draws()).toBeGreaterThan(0);
    expect(calls).toContain('mkdir');
    expect(calls).toContain('rename');
    calls.length = 0;
    expect((await blobs.read(ref.handle, { lineStart: 2, lineEnd: 3 })).text).toBe('two\nthree éè\n');
    expect(await blobs.read(ref.handle, { offset: 4, length: 3 })).toMatchObject({ text: 'two', offset: 4, length: 3 });
    expect(calls.length).toBeGreaterThan(0);
    expect(new Set(calls)).toEqual(new Set(['readRange']));
  });

  it('reads the content the port holds, not the content of the host file', async () => {
    const { dbPath, store, clock } = harness();
    store.close();
    const held = Buffer.from('port\nheld\n', 'utf8');
    const { fileSystem } = recording({ readRange: async (_file, position, length) => held.subarray(position, position + length) });
    const blobs = createBlobStore(rawDb(dbPath), clock, blobDirectoryOf(dbPath), { lock: testKernelLock(), fileSystem, random: systemRandom });
    const ref = await blobs.put('host\nfile\n', { mediaType: 'text/plain' });

    expect((await blobs.read(ref.handle, { lineStart: 1, lineEnd: 2 })).text).toBe('port\nheld\n');
    expect((await blobs.read(ref.handle, { offset: 0, length: 4 })).text).toBe('port');
  });

  it('reads a line range that spans several pages of the port', async () => {
    const { store } = harness();
    const line = `${'x'.repeat(1023)}\n`;
    const ref = await store.blobs.put(line.repeat(200), { mediaType: 'text/plain' });

    const slice = await store.blobs.read(ref.handle, { lineStart: 100, lineEnd: 199 });

    expect(slice.text).toBe(line.repeat(100));
    expect(slice.totalLines).toBe(200);
  });

  it('names a blob whose file is shorter than its recorded length', async () => {
    const { dbPath, store, clock } = harness();
    store.close();
    const { fileSystem } = recording({ readRange: async () => new Uint8Array(0) });
    const blobs = createBlobStore(rawDb(dbPath), clock, blobDirectoryOf(dbPath), { lock: testKernelLock(), fileSystem, random: systemRandom });
    const ref = await blobs.put('content', { mediaType: 'text/plain' });

    await expect(blobs.read(ref.handle, { offset: 0, length: 4 })).rejects.toThrow(/shorter than its recorded length/);
    await expect(blobs.read(ref.handle, { lineStart: 1, lineEnd: 1 })).rejects.toThrow(/shorter than its recorded length/);
  });
});
