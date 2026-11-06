import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { RELEASE_ASSETS, parseChecksumListing } from '@momonga/foundation';
import type { ReleaseTargetName } from '@momonga/foundation';

export const SEA_NODE_VERSION = '26.12.1';
export const SEA_NODE_PLATFORM = 'darwin-arm64';
export const SEA_NODE_ARCHIVE_SHA256 = '1901d539912c02afa10d1cc126943a8855a7eedebe830119463470db5e6c59e8';

export type SeaTargetName = ReleaseTargetName;

export type SeaTarget = {
  readonly name: SeaTargetName;
  readonly archiveExtension: 'tar.gz' | 'zip';
  readonly archiveSha256: string;
  readonly nodeRelativePath: readonly string[];
  readonly assetName: string;
};

export const SEA_TARGETS: Readonly<Record<SeaTargetName, SeaTarget>> = {
  'darwin-arm64': {
    name: 'darwin-arm64',
    archiveExtension: 'tar.gz',
    archiveSha256: SEA_NODE_ARCHIVE_SHA256,
    nodeRelativePath: ['bin', 'node'],
    assetName: RELEASE_ASSETS['darwin-arm64'],
  },
  'linux-x64': {
    name: 'linux-x64',
    archiveExtension: 'tar.gz',
    archiveSha256: '0fd1eb7770598f52a21995edf6ed35fc690400fa437c2386af329519e9143132',
    nodeRelativePath: ['bin', 'node'],
    assetName: RELEASE_ASSETS['linux-x64'],
  },
  'linux-arm64': {
    name: 'linux-arm64',
    archiveExtension: 'tar.gz',
    archiveSha256: 'a6c01af459dd8972ab3fb08ee5da81244d26ba8c4944a62d5bbba8c597ae154f',
    nodeRelativePath: ['bin', 'node'],
    assetName: RELEASE_ASSETS['linux-arm64'],
  },
  'win-x64': {
    name: 'win-x64',
    archiveExtension: 'zip',
    archiveSha256: 'b3efd5c70cba3308ed46e7e699a9b8aac075bbc6b027fcb39c84c31acc25e2b4',
    nodeRelativePath: ['node.exe'],
    assetName: RELEASE_ASSETS['win-x64'],
  },
};

export const isSeaTargetName = (value: string): value is SeaTargetName => Object.hasOwn(SEA_TARGETS, value);

const DIST_BASE_URL = `https://nodejs.org/dist/v${SEA_NODE_VERSION}`;
const archiveStemOf = (target: SeaTarget): string => `node-v${SEA_NODE_VERSION}-${target.name}`;
const archiveNameOf = (target: SeaTarget): string => `${archiveStemOf(target)}.${target.archiveExtension}`;

export const sha256OfFile = (file: string): string => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

export const parseShasums = (shasums: string): ReadonlyMap<string, string> => parseChecksumListing(shasums, 'SHASUMS256');

export const assertPinnedChecksum = (shasums: string, archiveName: string, pinned: string): void => {
  const published = parseShasums(shasums).get(archiveName);
  if (published === undefined) throw new Error(`${archiveName} is not listed in SHASUMS256.txt`);
  if (published !== pinned) throw new Error(`SHASUMS256.txt lists ${published} for ${archiveName}, pinned checksum is ${pinned}`);
};

export const assertFileChecksum = (file: string, expected: string): void => {
  const actual = sha256OfFile(file);
  if (actual !== expected) throw new Error(`sha256 mismatch for ${file}: expected ${expected}, got ${actual}`);
};

export const download = async (url: string): Promise<Buffer> => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`GET ${url} failed with HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
};

const archiveMatchesPin = (archive: string, pinned: string): boolean => fs.existsSync(archive) && sha256OfFile(archive) === pinned;

export type ExtractCommand = { readonly file: string; readonly args: readonly string[] };

export const extractCommand = (target: Pick<SeaTarget, 'archiveExtension'>, archive: string, cacheDir: string, platform: NodeJS.Platform, env: Readonly<Record<string, string | undefined>>): ExtractCommand => {
  if (platform === 'win32') {
    const systemRoot = env['SystemRoot'];
    if (systemRoot === undefined) throw new Error('SystemRoot is required to find the Windows tar.exe');
    return { file: `${systemRoot}\\System32\\tar.exe`, args: target.archiveExtension === 'tar.gz' ? ['-xzf', archive, '-C', cacheDir] : ['-xf', archive, '-C', cacheDir] };
  }
  if (target.archiveExtension === 'tar.gz') return { file: '/usr/bin/tar', args: ['-xzf', archive, '-C', cacheDir] };
  if (platform === 'darwin') return { file: '/usr/bin/tar', args: ['-xf', archive, '-C', cacheDir] };
  return { file: '/usr/bin/unzip', args: ['-q', '-o', archive, '-d', cacheDir] };
};

export const ensureSeaNode = async (cacheDir: string, targetName: SeaTargetName = SEA_NODE_PLATFORM): Promise<string> => {
  const target = SEA_TARGETS[targetName];
  const archiveName = archiveNameOf(target);
  fs.mkdirSync(cacheDir, { recursive: true });
  const archive = path.join(cacheDir, archiveName);
  if (!archiveMatchesPin(archive, target.archiveSha256)) {
    const shasums = (await download(`${DIST_BASE_URL}/SHASUMS256.txt`)).toString('utf8');
    assertPinnedChecksum(shasums, archiveName, target.archiveSha256);
    const partial = `${archive}.partial`;
    fs.writeFileSync(partial, await download(`${DIST_BASE_URL}/${archiveName}`));
    try {
      assertFileChecksum(partial, target.archiveSha256);
    } catch (error) {
      fs.rmSync(partial, { force: true });
      throw error;
    }
    fs.renameSync(partial, archive);
  }
  const extracted = path.join(cacheDir, archiveStemOf(target));
  fs.rmSync(extracted, { recursive: true, force: true });
  const { file, args } = extractCommand(target, archive, cacheDir, process.platform, process.env);
  execFileSync(file, [...args]);
  return path.join(extracted, ...target.nodeRelativePath);
};
