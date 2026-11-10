import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RELEASE_ASSETS, WINDOWS_KEEPER_BINARY_ASSET, WINDOWS_KEEPER_MANIFEST_ASSET, WindowsKeeperDistributionError, ensureBundledWindowsKeeper, nodeFileSystem, parseWindowsKeeperManifest, sha256Hex } from '@momonga/foundation';
import type { ReleaseTargetName } from '@momonga/foundation';
import { UNBOUNDED_BUILD_WAIT_MS } from './support/build-wait.ts';
import { createTempRoot, removeTempRoot } from './support/temp.ts';
import { WINDOWS_KEEPER_SOURCE, WINDOWS_KEEPER_TARGETS, buildWindowsKeeperAssets, compileCommandOf } from './windows-keeper.ts';

const TARGET = 'win-x64';

describe('the keeper asset of the single executable (T-JO-8)', () => {
  let root = '';
  let assets: Record<string, string> = {};

  const read = (name: string): Uint8Array => fs.readFileSync(assets[name] as string);
  const extractInto = (cache: string, asset: (name: string) => Uint8Array = read): Promise<string> =>
    ensureBundledWindowsKeeper({ asset, executablesRoot: path.join(root, cache), random: { hex: () => 'abcdef0123456789' }, files: nodeFileSystem });

  beforeAll(async () => {
    root = fs.realpathSync(createTempRoot());
    assets = await buildWindowsKeeperAssets(path.join(root, 'work'), TARGET);
  }, UNBOUNDED_BUILD_WAIT_MS);

  afterAll(async () => {
    await removeTempRoot(root);
  });

  it('is built from the one C source by the one compile command, for every release target that runs Windows and for no other', () => {
    expect(fs.existsSync(WINDOWS_KEEPER_SOURCE)).toBe(true);
    expect(Object.keys(WINDOWS_KEEPER_TARGETS)).toEqual((Object.keys(RELEASE_ASSETS) as ReleaseTargetName[]).filter((name) => RELEASE_ASSETS[name].endsWith('.exe')));
    expect(compileCommandOf('in.c', 'out.exe', 'x86_64-windows-gnu')).toEqual({
      file: 'zig',
      args: ['cc', '-target', 'x86_64-windows-gnu', '-municode', '-Os', '-s', '-Wall', '-Wextra', '-Werror', '-o', 'out.exe', 'in.c', '-ladvapi32'],
    });
  });

  it('names exactly the manifest and the binary, and the sha256 and the size in the manifest are those of the built binary', () => {
    expect(Object.keys(assets).sort()).toEqual([WINDOWS_KEEPER_BINARY_ASSET, WINDOWS_KEEPER_MANIFEST_ASSET].sort());
    const manifest = parseWindowsKeeperManifest(fs.readFileSync(assets[WINDOWS_KEEPER_MANIFEST_ASSET] as string, 'utf8'));
    const binary = read(WINDOWS_KEEPER_BINARY_ASSET);
    expect(manifest).toEqual({ target: TARGET, binary: { asset: WINDOWS_KEEPER_BINARY_ASSET, sha256: sha256Hex(binary), size: binary.length, name: 'momonga-keeper.exe' } });
    expect(Buffer.from(binary.subarray(0, 2)).toString('latin1')).toBe('MZ');
  });

  it('builds the same bytes again from the same source', async () => {
    const again = await buildWindowsKeeperAssets(path.join(root, 'work-again'), TARGET);
    expect(sha256Hex(fs.readFileSync(again[WINDOWS_KEEPER_BINARY_ASSET] as string))).toBe(sha256Hex(read(WINDOWS_KEEPER_BINARY_ASSET)));
  }, UNBOUNDED_BUILD_WAIT_MS);

  it('builds no keeper asset for a target that does not run Windows', async () => {
    expect(await buildWindowsKeeperAssets(path.join(root, 'work-other'), 'linux-x64')).toEqual({});
    expect(await buildWindowsKeeperAssets(path.join(root, 'work-other'), 'darwin-arm64')).toEqual({});
  });

  it('extracts into a folder named by the hash, with the bytes of the built binary and nothing staged left behind', async () => {
    const extracted = await extractInto('cache');
    const sha = sha256Hex(read(WINDOWS_KEEPER_BINARY_ASSET));
    expect(extracted).toBe(path.join(root, 'cache', `windows-keeper-${sha.slice(0, 16)}`, 'momonga-keeper.exe'));
    expect(sha256Hex(fs.readFileSync(extracted))).toBe(sha);
    expect(fs.readdirSync(path.dirname(extracted))).toEqual(['momonga-keeper.exe']);
  });

  it('a changed byte in the embedded binary fails extraction and extracts nothing', async () => {
    const changed = (name: string): Uint8Array => {
      const bytes = Uint8Array.from(read(name));
      if (name === WINDOWS_KEEPER_BINARY_ASSET) bytes[bytes.length - 1] = (bytes[bytes.length - 1] as number) ^ 1;
      return bytes;
    };
    await expect(extractInto('cache-changed', changed)).rejects.toThrow(WindowsKeeperDistributionError);
    const directories = fs.readdirSync(path.join(root, 'cache-changed'));
    expect(directories.flatMap((name) => fs.readdirSync(path.join(root, 'cache-changed', name)))).toEqual([]);
  });

  it('checks the hash on every call: a changed byte in the extracted file is replaced by the embedded binary', async () => {
    const extracted = await extractInto('cache-again');
    const bytes = fs.readFileSync(extracted);
    bytes[0] = (bytes[0] as number) ^ 1;
    fs.writeFileSync(extracted, bytes);
    expect(await extractInto('cache-again')).toBe(extracted);
    expect(sha256Hex(fs.readFileSync(extracted))).toBe(sha256Hex(read(WINDOWS_KEEPER_BINARY_ASSET)));
  });

  it.each(['[]', '{}', '{"target":"win-x64","binary":{"asset":"a","sha256":"zz","size":1,"name":"k.exe"}}', '{"target":"win-x64","binary":{"asset":"a","sha256":"' + 'a'.repeat(64) + '","size":0,"name":"k.exe"}}', '{"target":"win-x64","binary":{"asset":"a","sha256":"' + 'a'.repeat(64) + '","size":1,"name":"..\\\\k.exe"}}'])(
    'refuses the manifest %s',
    (text) => {
      expect(() => parseWindowsKeeperManifest(text)).toThrow(WindowsKeeperDistributionError);
    },
  );
});
