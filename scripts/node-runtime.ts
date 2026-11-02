import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const SEA_NODE_VERSION = '26.12.1';
export const SEA_NODE_PLATFORM = 'darwin-arm64';
export const SEA_NODE_ARCHIVE_SHA256 = '1901d539912c02afa10d1cc126943a8855a7eedebe830119463470db5e6c59e8';

const DIST_BASE_URL = `https://nodejs.org/dist/v${SEA_NODE_VERSION}`;
const ARCHIVE_STEM = `node-v${SEA_NODE_VERSION}-${SEA_NODE_PLATFORM}`;
const ARCHIVE_NAME = `${ARCHIVE_STEM}.tar.gz`;

export const sha256OfFile = (file: string): string => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

export const parseShasums = (shasums: string): ReadonlyMap<string, string> => {
  const entries = shasums
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => {
      const match = /^([0-9a-f]{64}) {2}(\S+)$/.exec(line);
      if (!match) throw new Error(`malformed SHASUMS256 line: ${line}`);
      return [match[2] as string, match[1] as string] as const;
    });
  return new Map(entries);
};

export const assertPinnedChecksum = (shasums: string, archiveName: string, pinned: string): void => {
  const published = parseShasums(shasums).get(archiveName);
  if (published === undefined) throw new Error(`${archiveName} is not listed in SHASUMS256.txt`);
  if (published !== pinned) throw new Error(`SHASUMS256.txt lists ${published} for ${archiveName}, pinned checksum is ${pinned}`);
};

export const assertFileChecksum = (file: string, expected: string): void => {
  const actual = sha256OfFile(file);
  if (actual !== expected) throw new Error(`sha256 mismatch for ${file}: expected ${expected}, got ${actual}`);
};

const download = async (url: string): Promise<Buffer> => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`GET ${url} failed with HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
};

const archiveMatchesPin = (archive: string): boolean => fs.existsSync(archive) && sha256OfFile(archive) === SEA_NODE_ARCHIVE_SHA256;

export const ensureSeaNode = async (cacheDir: string): Promise<string> => {
  fs.mkdirSync(cacheDir, { recursive: true });
  const archive = path.join(cacheDir, ARCHIVE_NAME);
  if (!archiveMatchesPin(archive)) {
    const shasums = (await download(`${DIST_BASE_URL}/SHASUMS256.txt`)).toString('utf8');
    assertPinnedChecksum(shasums, ARCHIVE_NAME, SEA_NODE_ARCHIVE_SHA256);
    const partial = `${archive}.partial`;
    fs.writeFileSync(partial, await download(`${DIST_BASE_URL}/${ARCHIVE_NAME}`));
    try {
      assertFileChecksum(partial, SEA_NODE_ARCHIVE_SHA256);
    } catch (error) {
      fs.rmSync(partial, { force: true });
      throw error;
    }
    fs.renameSync(partial, archive);
  }
  const extracted = path.join(cacheDir, ARCHIVE_STEM);
  fs.rmSync(extracted, { recursive: true, force: true });
  execFileSync('/usr/bin/tar', ['-xzf', archive, '-C', cacheDir]);
  return path.join(extracted, 'bin', 'node');
};
