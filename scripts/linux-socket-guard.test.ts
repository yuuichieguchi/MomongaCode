import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  LINUX_SOCKET_GUARD_BINARY_ASSET,
  LINUX_SOCKET_GUARD_MANIFEST_ASSET,
  LinuxSocketGuardDistributionError,
  RELEASE_ASSETS,
  ensureBundledLinuxSocketGuard,
  nodeFileSystem,
  parseLinuxSocketGuardManifest,
  sha256Hex,
} from '@momonga/foundation';
import type { ReleaseTargetName } from '@momonga/foundation';
import { UNBOUNDED_BUILD_WAIT_MS } from './support/build-wait.ts';
import { createTempRoot, removeTempRoot } from './support/temp.ts';
import { LINUX_SOCKET_GUARD_SOURCE, LINUX_SOCKET_GUARD_TARGETS, LINUX_SOCKET_PROBE_SOURCE, buildLinuxSocketGuardAssets, compileLinuxProgram, linuxCompileCommandOf } from './linux-socket-guard.ts';

const ELF_MAGIC = '\u007fELF';
const ELF_MACHINE_OFFSET = 18;
const ELF_MACHINES: Readonly<Record<string, number>> = { 'linux-x64': 62, 'linux-arm64': 183 };
const LINUX_TARGETS = ['linux-x64', 'linux-arm64'] as const;

describe('the socket guard asset of the single executable for Linux', () => {
  let root = '';
  const built = new Map<string, Record<string, string>>();

  const read = (target: string, name: string): Uint8Array => fs.readFileSync((built.get(target) as Record<string, string>)[name] as string);
  const extractInto = (cache: string, asset: (name: string) => Uint8Array): Promise<string> =>
    ensureBundledLinuxSocketGuard({ asset, executablesRoot: path.join(root, cache), random: { hex: () => 'abcdef0123456789' }, files: nodeFileSystem });

  beforeAll(async () => {
    root = fs.realpathSync(createTempRoot());
    for (const target of LINUX_TARGETS) built.set(target, await buildLinuxSocketGuardAssets(path.join(root, `work-${target}`), target));
  }, UNBOUNDED_BUILD_WAIT_MS);

  afterAll(async () => {
    await removeTempRoot(root);
  });

  it('is built from the one C source, for every release target that runs Linux and for no other, by one compile command per compiler', () => {
    expect(fs.existsSync(LINUX_SOCKET_GUARD_SOURCE)).toBe(true);
    expect(Object.keys(LINUX_SOCKET_GUARD_TARGETS)).toEqual((Object.keys(RELEASE_ASSETS) as ReleaseTargetName[]).filter((name) => name.startsWith('linux-')));
    expect(linuxCompileCommandOf('in.c', 'out', { kind: 'zig', zigTarget: 'x86_64-linux-musl' })).toEqual({
      file: 'zig',
      args: ['cc', '-target', 'x86_64-linux-musl', '-static', '-Os', '-s', '-Wall', '-Wextra', '-Werror', '-pthread', '-o', 'out', 'in.c'],
    });
    expect(linuxCompileCommandOf('in.c', 'out', { kind: 'host' })).toEqual({ file: 'cc', args: ['-Os', '-s', '-Wall', '-Wextra', '-Werror', '-pthread', '-o', 'out', 'in.c'] });
  });

  it.each(LINUX_TARGETS)('for %s names exactly the manifest and the binary, and the binary is a static executable of that processor', (target) => {
    const assets = built.get(target) as Record<string, string>;
    expect(Object.keys(assets).sort()).toEqual([LINUX_SOCKET_GUARD_BINARY_ASSET, LINUX_SOCKET_GUARD_MANIFEST_ASSET].sort());
    const binary = read(target, LINUX_SOCKET_GUARD_BINARY_ASSET);
    expect(parseLinuxSocketGuardManifest(fs.readFileSync(assets[LINUX_SOCKET_GUARD_MANIFEST_ASSET] as string, 'utf8'))).toEqual({
      target,
      binary: { asset: LINUX_SOCKET_GUARD_BINARY_ASSET, sha256: sha256Hex(binary), size: binary.length, name: 'momonga-socket-guard' },
    });
    expect(Buffer.from(binary.subarray(0, 4)).toString('latin1')).toBe(ELF_MAGIC);
    expect(Buffer.from(binary).readUInt16LE(ELF_MACHINE_OFFSET)).toBe(ELF_MACHINES[target]);
    expect(Buffer.from(binary).includes('ld-linux')).toBe(false);
  });

  it('builds the same bytes again from the same source', async () => {
    const again = await buildLinuxSocketGuardAssets(path.join(root, 'work-again'), 'linux-x64');
    expect(sha256Hex(fs.readFileSync(again[LINUX_SOCKET_GUARD_BINARY_ASSET] as string))).toBe(sha256Hex(read('linux-x64', LINUX_SOCKET_GUARD_BINARY_ASSET)));
  }, UNBOUNDED_BUILD_WAIT_MS);

  it('builds no socket guard asset for a target that does not run Linux', async () => {
    expect(await buildLinuxSocketGuardAssets(path.join(root, 'work-other'), 'darwin-arm64')).toEqual({});
    expect(await buildLinuxSocketGuardAssets(path.join(root, 'work-other'), 'win-x64')).toEqual({});
  });

  it('extracts into a folder named by the hash, as a file only its owner can run, with nothing staged left behind', async () => {
    const extracted = await extractInto('cache', (name) => read('linux-x64', name));
    const sha = sha256Hex(read('linux-x64', LINUX_SOCKET_GUARD_BINARY_ASSET));
    expect(extracted).toBe(path.join(root, 'cache', `linux-socket-guard-${sha.slice(0, 16)}`, 'momonga-socket-guard'));
    expect(sha256Hex(fs.readFileSync(extracted))).toBe(sha);
    expect(fs.statSync(extracted).mode & 0o777).toBe(0o700);
    expect(fs.readdirSync(path.dirname(extracted))).toEqual(['momonga-socket-guard']);
  });

  it('a changed byte in the embedded binary fails extraction and extracts nothing', async () => {
    const changed = (name: string): Uint8Array => {
      const bytes = Uint8Array.from(read('linux-x64', name));
      if (name === LINUX_SOCKET_GUARD_BINARY_ASSET) bytes[bytes.length - 1] = (bytes[bytes.length - 1] as number) ^ 1;
      return bytes;
    };
    await expect(extractInto('cache-changed', changed)).rejects.toThrow(LinuxSocketGuardDistributionError);
    const directories = fs.readdirSync(path.join(root, 'cache-changed'));
    expect(directories.flatMap((name) => fs.readdirSync(path.join(root, 'cache-changed', name)))).toEqual([]);
  });

  it('the probe program of the host test compiles for Linux with the same command', () => {
    const output = path.join(root, 'probe', 'socket-probe');
    compileLinuxProgram(LINUX_SOCKET_PROBE_SOURCE, output, { kind: 'zig', zigTarget: 'x86_64-linux-musl' });
    expect(fs.readFileSync(output).subarray(0, 4).toString('latin1')).toBe(ELF_MAGIC);
  }, UNBOUNDED_BUILD_WAIT_MS);
});
