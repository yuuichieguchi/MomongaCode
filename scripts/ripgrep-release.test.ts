import fs from 'node:fs';
import path from 'node:path';
import { brotliDecompressSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RELEASE_ASSETS, sha256Hex } from '@momonga/foundation';
import type { ReleaseTargetName } from '@momonga/foundation';
import { RIPGREP_BINARY_ASSET, RIPGREP_MANIFEST_ASSET, RIPGREP_NOTICES_ASSET, parseRipgrepManifest } from '@momonga/tools';
import { RIPGREP_TARGETS, RIPGREP_VERSION, buildRipgrepAssets, hasExecutableFormat } from './ripgrep-release.ts';
import { createTempRoot, removeTempRoot } from './support/temp.ts';

const PINS: Record<ReleaseTargetName, { archive: string; sha256: string; member: string }> = {
  'darwin-arm64': {
    archive: 'ripgrep-15.2.0-aarch64-apple-darwin.tar.gz',
    sha256: '3750b2e93f37e0c692657da574d7019a101c0084da05a790c83fd335bad973e4',
    member: 'ripgrep-15.2.0-aarch64-apple-darwin/rg',
  },
  'linux-x64': {
    archive: 'ripgrep-15.2.0-x86_64-unknown-linux-musl.tar.gz',
    sha256: '33e15bcf1624b25cdd2a55813a47a2f95dbe126268203e76aa6a585d1e7b149c',
    member: 'ripgrep-15.2.0-x86_64-unknown-linux-musl/rg',
  },
  'linux-arm64': {
    archive: 'ripgrep-15.2.0-aarch64-unknown-linux-musl.tar.gz',
    sha256: '800b1e7206afe799dfb5a6901f23147cfaabe0e52210538100f61e86e1740915',
    member: 'ripgrep-15.2.0-aarch64-unknown-linux-musl/rg',
  },
  'win-x64': {
    archive: 'ripgrep-15.2.0-x86_64-pc-windows-msvc.zip',
    sha256: '71b2fef860abe467217a538ff31de02f5258807c0129f771846f87bd029aafc5',
    member: 'ripgrep-15.2.0-x86_64-pc-windows-msvc/rg.exe',
  },
};

describe('ripgrep pins', () => {
  it('pins ripgrep 15.2.0', () => {
    expect(RIPGREP_VERSION).toBe('15.2.0');
  });

  it('has one row for every release asset and none besides', () => {
    expect(Object.keys(RIPGREP_TARGETS).sort()).toEqual(Object.keys(RELEASE_ASSETS).sort());
  });

  it.each(Object.entries(PINS))('pins the archive, digest and member of %s', (target, pin) => {
    expect(RIPGREP_TARGETS[target as ReleaseTargetName]).toMatchObject({ archiveName: pin.archive, archiveSha256: pin.sha256, memberPath: pin.member });
  });

  it('pins a unique 64-hex digest per target, with the version in each archive name and the member inside that archive', () => {
    const digests = Object.values(RIPGREP_TARGETS).map((row) => row.archiveSha256);
    for (const digest of digests) expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(new Set(digests).size).toBe(Object.keys(RELEASE_ASSETS).length);
    for (const row of Object.values(RIPGREP_TARGETS)) {
      expect(row.archiveName).toContain(RIPGREP_VERSION);
      expect(row.memberPath.startsWith(row.archiveName.replace(/\.(tar\.gz|zip)$/, ''))).toBe(true);
      expect(path.posix.basename(row.memberPath)).toBe(row.binaryName);
    }
    expect(RIPGREP_TARGETS['win-x64'].binaryName).toBe('rg.exe');
  });

  it('checks the executable format by magic bytes of the target', () => {
    const elf = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 0]);
    const pe = Buffer.from('MZ\u0090\u0000');
    const macho = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 0]);
    expect(hasExecutableFormat('linux-x64', elf)).toBe(true);
    expect(hasExecutableFormat('linux-arm64', elf)).toBe(true);
    expect(hasExecutableFormat('win-x64', pe)).toBe(true);
    expect(hasExecutableFormat('darwin-arm64', macho)).toBe(true);
    expect(hasExecutableFormat('linux-x64', pe)).toBe(false);
    expect(hasExecutableFormat('win-x64', elf)).toBe(false);
    expect(hasExecutableFormat('darwin-arm64', elf)).toBe(false);
  });
});

describe('buildRipgrepAssets (downloads the pinned archives into .cache/ripgrep, or reuses them)', () => {
  let root = '';

  beforeAll(() => {
    root = createTempRoot();
  });

  afterAll(() => {
    removeTempRoot(root);
  });

  it.each(Object.keys(PINS) as ReleaseTargetName[])('produces a manifest, a compressed binary of the right format, and the notices for %s', async (target) => {
    const assets = await buildRipgrepAssets(path.join(root, target), target);
    expect(Object.keys(assets).sort()).toEqual([RIPGREP_BINARY_ASSET, RIPGREP_MANIFEST_ASSET, RIPGREP_NOTICES_ASSET].sort());
    const manifest = parseRipgrepManifest(fs.readFileSync(assets[RIPGREP_MANIFEST_ASSET] as string, 'utf8'));
    expect(manifest.version).toBe(RIPGREP_VERSION);
    expect(manifest.target).toBe(target);
    expect(manifest.binary.name).toBe(RIPGREP_TARGETS[target].binaryName);
    const binary = brotliDecompressSync(fs.readFileSync(assets[RIPGREP_BINARY_ASSET] as string));
    expect(sha256Hex(binary)).toBe(manifest.binary.sha256);
    expect(binary.length).toBe(manifest.binary.size);
    expect(hasExecutableFormat(target, binary)).toBe(true);
    const notices = fs.readFileSync(assets[RIPGREP_NOTICES_ASSET] as string);
    expect(sha256Hex(notices)).toBe(manifest.notices.sha256);
    const text = notices.toString('utf8');
    for (const file of ['COPYING', 'UNLICENSE', 'LICENSE-MIT']) expect(text).toContain(file);
  });
});
