import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { constants, brotliCompressSync } from 'node:zlib';
import { sha256Hex } from '@momonga/foundation';
import type { ReleaseTargetName } from '@momonga/foundation';
import { RIPGREP_BINARY_ASSET, RIPGREP_MANIFEST_ASSET, RIPGREP_NOTICES_ASSET } from '@momonga/tools';
import type { RipgrepManifest } from '@momonga/tools';
import { repoRoot } from './bundle.ts';
import { assertFileChecksum, download, extractCommand, sha256OfFile } from './node-runtime.ts';
import { Z3_BROTLI_QUALITY, Z3_BROTLI_WINDOW_BITS } from './z3-assets.ts';

export const RIPGREP_VERSION = '15.2.0';

export type ExecutableFormat = 'elf' | 'pe' | 'macho';

export type RipgrepTarget = {
  readonly archiveName: string;
  readonly archiveExtension: 'tar.gz' | 'zip';
  readonly archiveSha256: string;
  readonly memberPath: string;
  readonly binaryName: string;
  readonly format: ExecutableFormat;
};

const rowOf = (triple: string, archiveExtension: 'tar.gz' | 'zip', archiveSha256: string, binaryName: string, format: ExecutableFormat): RipgrepTarget => {
  const stem = `ripgrep-${RIPGREP_VERSION}-${triple}`;
  return { archiveName: `${stem}.${archiveExtension}`, archiveExtension, archiveSha256, memberPath: `${stem}/${binaryName}`, binaryName, format };
};

export const RIPGREP_TARGETS: Readonly<Record<ReleaseTargetName, RipgrepTarget>> = {
  'darwin-arm64': rowOf('aarch64-apple-darwin', 'tar.gz', '3750b2e93f37e0c692657da574d7019a101c0084da05a790c83fd335bad973e4', 'rg', 'macho'),
  'linux-x64': rowOf('x86_64-unknown-linux-musl', 'tar.gz', '33e15bcf1624b25cdd2a55813a47a2f95dbe126268203e76aa6a585d1e7b149c', 'rg', 'elf'),
  'linux-arm64': rowOf('aarch64-unknown-linux-musl', 'tar.gz', '800b1e7206afe799dfb5a6901f23147cfaabe0e52210538100f61e86e1740915', 'rg', 'elf'),
  'win-x64': rowOf('x86_64-pc-windows-msvc', 'zip', '71b2fef860abe467217a538ff31de02f5258807c0129f771846f87bd029aafc5', 'rg.exe', 'pe'),
};

export const RIPGREP_LICENCE_FILES: readonly string[] = ['COPYING', 'UNLICENSE', 'LICENSE-MIT'];

export const ripgrepCacheDir = `${repoRoot}.cache/ripgrep`;

const RELEASE_BASE_URL = `https://github.com/BurntSushi/ripgrep/releases/download/${RIPGREP_VERSION}`;

const MAGIC: Readonly<Record<ExecutableFormat, readonly number[]>> = {
  elf: [0x7f, 0x45, 0x4c, 0x46],
  pe: [0x4d, 0x5a],
  macho: [0xcf, 0xfa, 0xed, 0xfe],
};

export const hasExecutableFormat = (target: ReleaseTargetName, bytes: Uint8Array): boolean => {
  const magic = MAGIC[RIPGREP_TARGETS[target].format];
  return bytes.length >= magic.length && magic.every((byte, index) => bytes[index] === byte);
};

export const publishedDigestOf = (published: string, fileName: string): string => {
  const digests = new Set([...published.matchAll(/(?<![0-9A-Fa-f])[0-9A-Fa-f]{64}(?![0-9A-Fa-f])/g)].map((match) => match[0].toLowerCase()));
  if (digests.size !== 1) throw new Error(`${fileName} must hold exactly one sha256 digest, found ${digests.size}`);
  return [...digests][0] as string;
};

export const assertPublishedChecksum = (published: string, row: RipgrepTarget): void => {
  const digest = publishedDigestOf(published, `${row.archiveName}.sha256`);
  if (digest !== row.archiveSha256) throw new Error(`${row.archiveName}.sha256 lists ${digest}, pinned checksum is ${row.archiveSha256}`);
};

export const ensureRipgrepArchive = async (cacheDir: string, target: ReleaseTargetName): Promise<string> => {
  const row = RIPGREP_TARGETS[target];
  fs.mkdirSync(cacheDir, { recursive: true });
  const archive = path.join(cacheDir, row.archiveName);
  if (fs.existsSync(archive) && sha256OfFile(archive) === row.archiveSha256) return archive;
  assertPublishedChecksum((await download(`${RELEASE_BASE_URL}/${row.archiveName}.sha256`)).toString('utf8'), row);
  const partial = `${archive}.partial`;
  fs.writeFileSync(partial, await download(`${RELEASE_BASE_URL}/${row.archiveName}`));
  try {
    assertFileChecksum(partial, row.archiveSha256);
  } catch (error) {
    fs.rmSync(partial, { force: true });
    throw error;
  }
  fs.renameSync(partial, archive);
  return archive;
};

const extractArchive = (row: RipgrepTarget, archive: string, directory: string): void => {
  fs.rmSync(directory, { recursive: true, force: true });
  fs.mkdirSync(directory, { recursive: true });
  const { file, args } = extractCommand(row, archive, directory, process.platform, process.env);
  execFileSync(file, [...args]);
};

const memberOf = (directory: string, relative: string, archiveName: string): Buffer => {
  const file = path.join(directory, ...relative.split('/'));
  if (!fs.existsSync(file) || !fs.lstatSync(file).isFile()) throw new Error(`${archiveName} has no regular file ${relative}`);
  return fs.readFileSync(file);
};

const noticesOf = (directory: string, row: RipgrepTarget): Buffer => {
  const root = path.posix.dirname(row.memberPath);
  return Buffer.concat(
    RIPGREP_LICENCE_FILES.flatMap((name) => [Buffer.from(`===== ${name} (ripgrep ${RIPGREP_VERSION}) =====\n`), memberOf(directory, `${root}/${name}`, row.archiveName), Buffer.from('\n')]),
  );
};

export const buildRipgrepAssets = async (workDir: string, target: ReleaseTargetName, cacheDir: string = ripgrepCacheDir): Promise<Record<string, string>> => {
  const row = RIPGREP_TARGETS[target];
  const archive = await ensureRipgrepArchive(cacheDir, target);
  const directory = path.join(workDir, 'ripgrep');
  const extracted = path.join(directory, 'extracted');
  extractArchive(row, archive, extracted);
  const binary = memberOf(extracted, row.memberPath, row.archiveName);
  if (!hasExecutableFormat(target, binary)) throw new Error(`${row.memberPath} in ${row.archiveName} is not a ${row.format} executable`);
  const notices = noticesOf(extracted, row);
  const compressedFile = path.join(directory, RIPGREP_BINARY_ASSET);
  fs.writeFileSync(
    compressedFile,
    brotliCompressSync(binary, { params: { [constants.BROTLI_PARAM_QUALITY]: Z3_BROTLI_QUALITY, [constants.BROTLI_PARAM_LGWIN]: Z3_BROTLI_WINDOW_BITS, [constants.BROTLI_PARAM_SIZE_HINT]: binary.length } }),
  );
  const noticesFile = path.join(directory, RIPGREP_NOTICES_ASSET);
  fs.writeFileSync(noticesFile, notices);
  const manifest: RipgrepManifest = {
    version: RIPGREP_VERSION,
    target,
    binary: { asset: RIPGREP_BINARY_ASSET, sha256: sha256Hex(binary), size: binary.length, name: row.binaryName },
    notices: { asset: RIPGREP_NOTICES_ASSET, sha256: sha256Hex(notices) },
  };
  const manifestFile = path.join(directory, RIPGREP_MANIFEST_ASSET);
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  fs.rmSync(extracted, { recursive: true, force: true });
  return { [RIPGREP_MANIFEST_ASSET]: manifestFile, [RIPGREP_BINARY_ASSET]: compressedFile, [RIPGREP_NOTICES_ASSET]: noticesFile };
};
