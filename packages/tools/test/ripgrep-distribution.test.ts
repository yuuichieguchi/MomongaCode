import type fs from 'node:fs';
import path from 'node:path';
import { brotliCompressSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { sha256Hex } from '@momonga/foundation';
import type { ClaimOutcome, KernelLockMechanism } from '@momonga/foundation';
import {
  RIPGREP_BINARY_ASSET,
  RIPGREP_MANIFEST_ASSET,
  RIPGREP_NOTICES_ASSET,
  RipgrepDistributionError,
  ensureBundledRipgrep,
  parseRipgrepManifest,
} from '../src/ripgrep-distribution.ts';
import type { RipgrepDistributionPorts } from '../src/ripgrep-distribution.ts';

const VERSION = '15.2.0';
const BINARY = new TextEncoder().encode('#!rg-binary-bytes');
const NOTICES = new TextEncoder().encode('COPYING\nUNLICENSE\nLICENSE-MIT\n');
const AREA = path.join(path.sep, 'cache', 'momonga', 'executables');

const manifestFor = (binary: Uint8Array = BINARY, notices: Uint8Array = NOTICES) => ({
  version: VERSION,
  target: 'linux-x64',
  binary: { asset: RIPGREP_BINARY_ASSET, sha256: sha256Hex(binary), size: binary.length, name: 'rg' },
  notices: { asset: RIPGREP_NOTICES_ASSET, sha256: sha256Hex(notices) },
});

const DIRECTORY = path.join(AREA, `ripgrep-${VERSION}-${sha256Hex(BINARY).slice(0, 16)}`);
const FINAL = path.join(DIRECTORY, 'rg');

type Entry = { kind: 'file'; bytes: Uint8Array; mode: number } | { kind: 'directory' } | { kind: 'symlink' };

const errno = (message: string, code: string): Error => Object.assign(new Error(message), { code });

const statsOf = (entry: Entry): fs.Stats =>
  ({ isFile: () => entry.kind === 'file', isDirectory: () => entry.kind === 'directory', isSymbolicLink: () => entry.kind === 'symlink' }) as fs.Stats;

const makeFiles = () => {
  const entries = new Map<string, Entry>();
  const privateDirectories: string[] = [];
  const busy = new Set<string>();
  const failWrites = { next: false };
  const counts = { writes: 0, reads: new Map<string, number>(), renames: 0, removes: 0 };
  const opened: string[] = [];
  const mkdirs = (directory: string): void => {
    for (let current = directory; current !== path.dirname(current); current = path.dirname(current)) if (!entries.has(current)) entries.set(current, { kind: 'directory' });
  };
  const files: RipgrepDistributionPorts['files'] = {
    lstat: async (target) => {
      const entry = entries.get(target);
      if (entry === undefined) throw errno('missing', 'ENOENT');
      return statsOf(entry);
    },
    mkdirPrivate: async (directory) => {
      privateDirectories.push(directory);
      mkdirs(directory);
    },
    open: async (file, flags, mode) => {
      if (flags !== 'wx') throw new Error(`the fake opens only with wx, not ${flags}`);
      if (entries.has(file)) throw errno('exists', 'EEXIST');
      opened.push(file);
      entries.set(file, { kind: 'file', bytes: new Uint8Array(), mode: mode as number });
      return {
        writeFile: async (content) => {
          if (failWrites.next) {
            failWrites.next = false;
            throw errno('disk full', 'ENOSPC');
          }
          counts.writes += 1;
          entries.set(file, { kind: 'file', bytes: typeof content === 'string' ? new TextEncoder().encode(content) : new Uint8Array(content), mode: mode as number });
        },
        sync: async () => undefined,
        close: async () => undefined,
      };
    },
    readFile: async (file) => {
      counts.reads.set(file, (counts.reads.get(file) ?? 0) + 1);
      const entry = entries.get(file);
      if (entry?.kind !== 'file') throw errno('missing', 'ENOENT');
      return entry.bytes;
    },
    rename: async (from, to) => {
      counts.renames += 1;
      if (busy.has(to)) throw errno('busy', 'EBUSY');
      const entry = entries.get(from);
      if (entry === undefined) throw errno('missing', 'ENOENT');
      const existing = entries.get(to);
      if (existing?.kind === 'directory') throw errno('not empty', 'ENOTEMPTY');
      entries.delete(from);
      entries.set(to, entry);
    },
    rm: async (file) => {
      counts.removes += 1;
      entries.delete(file);
    },
    readdir: async (directory) => [...entries.keys()].filter((key) => path.dirname(key) === directory).map((key) => path.basename(key)),
  };
  return { entries, privateDirectories, busy, failWrites, counts, opened, files };
};

type Fixture = ReturnType<typeof makeFiles>;

const memoryLock = (held: ReadonlySet<string> = new Set()): KernelLockMechanism => {
  const claimSync = (lockPath: string): ClaimOutcome =>
    held.has(lockPath) ? { kind: 'held' } : { kind: 'claimed', lock: { descriptor: undefined, writeHolder: () => undefined, release: () => undefined, dispose: () => undefined } };
  return {
    name: 'file-lock',
    claim: async (lockPath) => claimSync(lockPath),
    claimSync,
    isHeld: async (lockPath) => held.has(lockPath),
    readHolder: async () => undefined,
    readHolderSync: () => undefined,
    claimInheritable: undefined,
    adoptInherited: undefined,
  };
};

const portsOf = (fixture: Fixture, overrides: Partial<RipgrepDistributionPorts> = {}, assets: Record<string, Uint8Array> = {}): RipgrepDistributionPorts => {
  const table: Record<string, Uint8Array> = {
    [RIPGREP_MANIFEST_ASSET]: new TextEncoder().encode(JSON.stringify(manifestFor())),
    [RIPGREP_BINARY_ASSET]: brotliCompressSync(BINARY),
    [RIPGREP_NOTICES_ASSET]: NOTICES,
    ...assets,
  };
  let counter = 0;
  return {
    asset: (name) => {
      const bytes = table[name];
      if (bytes === undefined) throw new Error(`no embedded asset ${name}`);
      return bytes;
    },
    executablesRoot: AREA,
    random: () => {
      counter += 1;
      return counter / 1000;
    },
    ownerId: 'self',
    lock: memoryLock(),
    files: fixture.files,
    ...overrides,
  };
};

const text = (entry: Entry | undefined): string => (entry?.kind === 'file' ? new TextDecoder().decode(entry.bytes) : '<not a file>');

const stagedNames = (fixture: Fixture): string[] => [...fixture.entries.keys()].filter((key) => path.basename(key).startsWith('rg.partial-'));

describe('parseRipgrepManifest', () => {
  it('reads the version, target, binary and notices entries', () => {
    expect(parseRipgrepManifest(JSON.stringify(manifestFor()))).toEqual(manifestFor());
  });

  it.each([
    ['not an object', '[]'],
    ['no version', JSON.stringify({ ...manifestFor(), version: undefined })],
    ['a binary checksum that is not 64 hex digits', JSON.stringify({ ...manifestFor(), binary: { ...manifestFor().binary, sha256: 'abc' } })],
    ['no binary name', JSON.stringify({ ...manifestFor(), binary: { ...manifestFor().binary, name: undefined } })],
    ['no notices entry', JSON.stringify({ ...manifestFor(), notices: undefined })],
  ])('rejects a manifest with %s', (_label, body) => {
    expect(() => parseRipgrepManifest(body)).toThrow(RipgrepDistributionError);
  });
});

describe('ensureBundledRipgrep', () => {
  it('extracts on first use into ripgrep-<version>-<hash prefix> under the cache base and returns the verified path', async () => {
    const fixture = makeFiles();
    const resolved = await ensureBundledRipgrep(portsOf(fixture));
    expect(resolved.path).toBe(FINAL);
    expect(resolved.version).toBe(VERSION);
    expect(text(fixture.entries.get(FINAL))).toBe('#!rg-binary-bytes');
    expect(fixture.entries.get(FINAL)).toMatchObject({ mode: 0o700 });
    expect(fixture.privateDirectories).toContain(DIRECTORY);
    expect(text(fixture.entries.get(path.join(DIRECTORY, 'NOTICE.txt')))).toBe('COPYING\nUNLICENSE\nLICENSE-MIT\n');
    await resolved.release();
    expect(stagedNames(fixture)).toEqual([]);
  });

  it('writes the binary through a staged file inside the directory and renames it over rg', async () => {
    const fixture = makeFiles();
    await ensureBundledRipgrep(portsOf(fixture));
    const written = fixture.opened.map((file) => path.basename(file));
    expect(written.some((name) => name.startsWith('rg.partial-self-'))).toBe(true);
    expect(written).not.toContain('rg');
  });

  it('reuses a good copy without writing anything', async () => {
    const fixture = makeFiles();
    const ports = portsOf(fixture);
    await (await ensureBundledRipgrep(ports)).release();
    const writes = fixture.counts.writes;
    const resolved = await ensureBundledRipgrep(ports);
    expect(resolved.path).toBe(FINAL);
    expect(fixture.counts.writes).toBe(writes);
  });

  it('hashes the file on every call, not once per process', async () => {
    const fixture = makeFiles();
    const ports = portsOf(fixture);
    await (await ensureBundledRipgrep(ports)).release();
    const before = fixture.counts.reads.get(FINAL) ?? 0;
    await ensureBundledRipgrep(ports);
    await ensureBundledRipgrep(ports);
    expect((fixture.counts.reads.get(FINAL) ?? 0) - before).toBe(2);
  });

  it('replaces a copy with the wrong bytes when the directory already exists, and returns the verified path', async () => {
    const fixture = makeFiles();
    fixture.entries.set(DIRECTORY, { kind: 'directory' });
    fixture.entries.set(FINAL, { kind: 'file', bytes: new TextEncoder().encode('corrupted'), mode: 0o700 });
    const resolved = await ensureBundledRipgrep(portsOf(fixture));
    expect(resolved.path).toBe(FINAL);
    expect(text(fixture.entries.get(FINAL))).toBe('#!rg-binary-bytes');
    expect(fixture.entries.get(DIRECTORY)).toEqual({ kind: 'directory' });
  });

  it('repairs a copy that was corrupted between two calls instead of spawning it', async () => {
    const fixture = makeFiles();
    const ports = portsOf(fixture);
    await (await ensureBundledRipgrep(ports)).release();
    fixture.entries.set(FINAL, { kind: 'file', bytes: new TextEncoder().encode('tampered'), mode: 0o700 });
    const resolved = await ensureBundledRipgrep(ports);
    expect(resolved.path).toBe(FINAL);
    expect(text(fixture.entries.get(FINAL))).toBe('#!rg-binary-bytes');
  });

  it('restores a deleted rg', async () => {
    const fixture = makeFiles();
    const ports = portsOf(fixture);
    await (await ensureBundledRipgrep(ports)).release();
    fixture.entries.delete(FINAL);
    await ensureBundledRipgrep(ports);
    expect(text(fixture.entries.get(FINAL))).toBe('#!rg-binary-bytes');
  });

  it('refuses an embedded binary that does not match its manifest, and writes nothing', async () => {
    const fixture = makeFiles();
    const ports = portsOf(fixture, {}, { [RIPGREP_BINARY_ASSET]: brotliCompressSync(new TextEncoder().encode('something else')) });
    await expect(ensureBundledRipgrep(ports)).rejects.toThrow(RipgrepDistributionError);
    await expect(ensureBundledRipgrep(ports)).rejects.toThrow(/does not match the checksum/);
    expect(fixture.entries.has(FINAL)).toBe(false);
    expect(fixture.counts.writes).toBe(0);
  });

  it.each([
    ['a symlink', { kind: 'symlink' } as Entry],
    ['a directory', { kind: 'directory' } as Entry],
  ])('refuses a final path that is %s', async (_label, entry) => {
    const fixture = makeFiles();
    fixture.entries.set(DIRECTORY, { kind: 'directory' });
    fixture.entries.set(FINAL, entry);
    await expect(ensureBundledRipgrep(portsOf(fixture))).rejects.toThrow(/not a regular file/);
    expect(fixture.entries.get(FINAL)).toEqual(entry);
  });

  it('does not memoize a failure and leaves no staged file behind', async () => {
    const fixture = makeFiles();
    const ports = portsOf(fixture);
    fixture.failWrites.next = true;
    await expect(ensureBundledRipgrep(ports)).rejects.toThrow(/disk full/);
    expect(stagedNames(fixture)).toEqual([]);
    const resolved = await ensureBundledRipgrep(ports);
    expect(resolved.path).toBe(FINAL);
    expect(text(fixture.entries.get(FINAL))).toBe('#!rg-binary-bytes');
  });

  it('spawns its own verified staged file when rg is in use, leaves rg for the next call, and removes the staged file on release', async () => {
    const fixture = makeFiles();
    fixture.entries.set(DIRECTORY, { kind: 'directory' });
    fixture.entries.set(FINAL, { kind: 'file', bytes: new TextEncoder().encode('old release bytes'), mode: 0o700 });
    fixture.busy.add(FINAL);
    const ports = portsOf(fixture);
    const resolved = await ensureBundledRipgrep(ports);
    expect(resolved.path).not.toBe(FINAL);
    expect(path.dirname(resolved.path)).toBe(DIRECTORY);
    expect(path.basename(resolved.path).startsWith('rg.partial-self-')).toBe(true);
    expect(text(fixture.entries.get(resolved.path))).toBe('#!rg-binary-bytes');
    expect(text(fixture.entries.get(FINAL))).toBe('old release bytes');
    await resolved.release();
    expect(stagedNames(fixture)).toEqual([]);
    fixture.busy.clear();
    const next = await ensureBundledRipgrep(ports);
    expect(next.path).toBe(FINAL);
    expect(text(fixture.entries.get(FINAL))).toBe('#!rg-binary-bytes');
  });

  it('sweeps staged files whose lock no one holds and keeps the staged files whose writer holds their lock', async () => {
    const fixture = makeFiles();
    fixture.entries.set(DIRECTORY, { kind: 'directory' });
    const stale = path.join(DIRECTORY, 'rg.partial-gone-1-aaaa');
    const alive = path.join(DIRECTORY, 'rg.partial-other-2-bbbb');
    fixture.entries.set(stale, { kind: 'file', bytes: BINARY, mode: 0o700 });
    fixture.entries.set(alive, { kind: 'file', bytes: BINARY, mode: 0o700 });
    const ports = portsOf(fixture, { lock: memoryLock(new Set([alive])) });
    await (await ensureBundledRipgrep(ports)).release();
    expect(fixture.entries.has(stale)).toBe(false);
    expect(fixture.entries.has(alive)).toBe(true);
  });

  it('lets two concurrent resolutions that share one cache both end with a verified file', async () => {
    const fixture = makeFiles();
    const [first, second] = await Promise.all([
      ensureBundledRipgrep(portsOf(fixture, { ownerId: 'a' })),
      ensureBundledRipgrep(portsOf(fixture, { ownerId: 'b' })),
    ]);
    expect(first.path).toBe(FINAL);
    expect(second.path).toBe(FINAL);
    expect(text(fixture.entries.get(FINAL))).toBe('#!rg-binary-bytes');
  });

  it('keeps a release with another binary hash in its own directory', async () => {
    const fixture = makeFiles();
    const other = new TextEncoder().encode('another release rg');
    const otherDirectory = path.join(AREA, `ripgrep-${VERSION}-${sha256Hex(other).slice(0, 16)}`);
    const resolvedOld = await ensureBundledRipgrep(portsOf(fixture));
    const resolvedNew = await ensureBundledRipgrep(
      portsOf(fixture, {}, { [RIPGREP_MANIFEST_ASSET]: new TextEncoder().encode(JSON.stringify(manifestFor(other))), [RIPGREP_BINARY_ASSET]: brotliCompressSync(other) }),
    );
    expect(resolvedOld.path).toBe(FINAL);
    expect(resolvedNew.path).toBe(path.join(otherDirectory, 'rg'));
    expect(text(fixture.entries.get(FINAL))).toBe('#!rg-binary-bytes');
  });
});
