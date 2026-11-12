import path from 'node:path';
import { brotliDecompressSync } from 'node:zlib';
import { createLockedEntry, parseShippedManifest, sha256Hex, sweepLeftovers } from '@momonga/foundation';
import type { FileSystem, KernelLockMechanism } from '@momonga/foundation';

export const Z3_MANIFEST_ASSET = 'z3-manifest.json';
export const Z3_API_FILE = 'z3-api.cjs';
export const Z3_RUNTIME_FILE = 'z3-built.js';
export const Z3_WASM_ASSET = 'z3-built.wasm.br';
export const Z3_STAGED_PREFIX = 'z3.partial-';
export const Z3_EXTRACTED_FILES: readonly string[] = [Z3_API_FILE, Z3_RUNTIME_FILE];

export type Z3Manifest = {
  contentHash: string;
  files: ReadonlyArray<{ name: string; sha256: string }>;
  wasm: { asset: string; sha256: string };
};

export type DistributionFiles = Pick<FileSystem, 'lstat' | 'mkdirPrivate' | 'open' | 'readFile' | 'rename' | 'rm' | 'readdir'>;

export type DistributionPorts = {
  asset(name: string): Uint8Array;
  files: DistributionFiles;
  executablesRoot: string;
  random(): number;
  lock: KernelLockMechanism;
};

export type BundledZ3 = { entry: string; wasmBinary: Uint8Array };

export class Z3DistributionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Z3DistributionError';
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

const hashField = (value: unknown, what: string): string => {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) throw new Z3DistributionError(`the Z3 manifest has no valid ${what}`);
  return value;
};

export const parseZ3Manifest = (text: string): Z3Manifest => {
  const parsed = parseShippedManifest(text, Z3_MANIFEST_ASSET, (message) => new Z3DistributionError(message));
  if (!isRecord(parsed) || !Array.isArray(parsed['files']) || !isRecord(parsed['wasm'])) throw new Z3DistributionError('the Z3 manifest is malformed');
  const wasm = parsed['wasm'];
  if (typeof wasm['asset'] !== 'string') throw new Z3DistributionError('the Z3 manifest names no solver binary');
  const files = (parsed['files'] as unknown[]).map((entry) => {
    if (!isRecord(entry) || typeof entry['name'] !== 'string') throw new Z3DistributionError('the Z3 manifest lists a file without a name');
    return { name: entry['name'], sha256: hashField(entry['sha256'], `checksum for ${entry['name']}`) };
  });
  return { contentHash: hashField(parsed['contentHash'], 'content hash'), files, wasm: { asset: wasm['asset'], sha256: hashField(wasm['sha256'], 'checksum for the solver binary') } };
};

const verifiedAsset = (ports: DistributionPorts, name: string, sha256: string): Uint8Array => {
  const bytes = ports.asset(name);
  if (sha256Hex(bytes) !== sha256) throw new Z3DistributionError(`the embedded Z3 asset ${name} does not match the checksum in its manifest`);
  return bytes;
};

const EXTRACTED_FILE_MODE = 0o600;

const codeOf = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | undefined)?.code;

const isStaged = (name: string): boolean => name.startsWith(Z3_STAGED_PREFIX);

const extractedMatches = async (files: DistributionFiles, file: string, sha256: string): Promise<boolean> => {
  let stat: Awaited<ReturnType<DistributionFiles['lstat']>>;
  try {
    stat = await files.lstat(file);
  } catch (error) {
    if (codeOf(error) === 'ENOENT') return false;
    throw error;
  }
  if (!stat.isFile()) throw new Z3DistributionError(`${file} is not a regular file; remove it so that the embedded Z3 distribution is extracted again`);
  return sha256Hex(await files.readFile(file)) === sha256;
};

const placeExtracted = async (ports: DistributionPorts, directory: string, name: string, bytes: Uint8Array): Promise<void> => {
  const stagedPath = path.join(directory, `${Z3_STAGED_PREFIX}${Math.floor(ports.random() * 0xffffffff).toString(16)}-${name}`);
  const staged = await createLockedEntry(ports.files, ports.lock, stagedPath, EXTRACTED_FILE_MODE);
  try {
    try {
      await staged.handle.writeFile(bytes);
    } finally {
      await staged.handle.close();
    }
    staged.assertStillNamed();
    await ports.files.rename(staged.path, path.join(directory, name));
  } catch (error) {
    await staged.remove();
    throw error;
  }
  staged.finish();
};

export const ensureBundledZ3 = async (ports: DistributionPorts): Promise<BundledZ3> => {
  const manifest = parseZ3Manifest(new TextDecoder().decode(ports.asset(Z3_MANIFEST_ASSET)));
  const directory = path.join(ports.executablesRoot, `z3-${manifest.contentHash.slice(0, 16)}`);
  await ports.files.mkdirPrivate(directory);
  await sweepLeftovers({
    directories: [{ directory, isLeftover: isStaged }],
    lock: ports.lock,
    files: { readdir: (entries) => ports.files.readdir(entries), rm: (entry) => ports.files.rm(entry, { recursive: true }) },
  });
  for (const file of manifest.files) {
    const extracted = path.join(directory, file.name);
    if (await extractedMatches(ports.files, extracted, file.sha256)) continue;
    await placeExtracted(ports, directory, file.name, verifiedAsset(ports, file.name, file.sha256));
    if (!(await extractedMatches(ports.files, extracted, file.sha256))) throw new Z3DistributionError(`${extracted} changed after it was extracted and does not match the embedded Z3 distribution`);
  }
  const wasmBinary = brotliDecompressSync(ports.asset(manifest.wasm.asset));
  if (sha256Hex(wasmBinary) !== manifest.wasm.sha256) throw new Z3DistributionError(`the embedded Z3 binary ${manifest.wasm.asset} does not match the checksum in its manifest`);
  return { entry: path.join(directory, Z3_API_FILE), wasmBinary };
};
