import path from 'node:path';
import { brotliDecompressSync } from 'node:zlib';
import { sha256Hex } from '@momonga/foundation';
import type { FileSystem } from '@momonga/foundation';

export const Z3_MANIFEST_ASSET = 'z3-manifest.json';
export const Z3_API_FILE = 'z3-api.cjs';
export const Z3_RUNTIME_FILE = 'z3-built.js';
export const Z3_WASM_ASSET = 'z3-built.wasm.br';
export const Z3_EXTRACTED_FILES: readonly string[] = [Z3_API_FILE, Z3_RUNTIME_FILE];

export type Z3Manifest = {
  contentHash: string;
  files: ReadonlyArray<{ name: string; sha256: string }>;
  wasm: { asset: string; sha256: string };
};

export type DistributionFiles = Pick<FileSystem, 'readFile' | 'mkdir' | 'rm' | 'rename'> & {
  exists(target: string): Promise<boolean>;
  writeBytes(file: string, bytes: Uint8Array): Promise<void>;
};

export type DistributionPorts = {
  asset(name: string): Uint8Array;
  files: DistributionFiles;
  executablesRoot: string;
  random(): number;
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
  const parsed: unknown = JSON.parse(text);
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

const extract = async (ports: DistributionPorts, manifest: Z3Manifest, directory: string): Promise<void> => {
  const partial = `${directory}.partial-${Math.floor(ports.random() * 0xffffffff).toString(16)}`;
  await ports.files.mkdir(partial);
  try {
    for (const file of manifest.files) await ports.files.writeBytes(path.join(partial, file.name), verifiedAsset(ports, file.name, file.sha256));
  } catch (error) {
    await ports.files.rm(partial, { recursive: true });
    throw error;
  }
  try {
    await ports.files.rename(partial, directory);
  } catch (error) {
    await ports.files.rm(partial, { recursive: true });
    if (!(await ports.files.exists(directory))) throw error;
  }
};

export const ensureBundledZ3 = async (ports: DistributionPorts): Promise<BundledZ3> => {
  const manifest = parseZ3Manifest(new TextDecoder().decode(ports.asset(Z3_MANIFEST_ASSET)));
  const directory = path.join(ports.executablesRoot, `z3-${manifest.contentHash.slice(0, 16)}`);
  if (!(await ports.files.exists(directory))) await extract(ports, manifest, directory);
  for (const file of manifest.files) {
    const bytes = await ports.files.readFile(path.join(directory, file.name));
    if (sha256Hex(bytes) !== file.sha256) throw new Z3DistributionError(`${path.join(directory, file.name)} does not match the embedded Z3 distribution; delete ${directory} so that it is extracted again`);
  }
  const wasmBinary = brotliDecompressSync(ports.asset(manifest.wasm.asset));
  if (sha256Hex(wasmBinary) !== manifest.wasm.sha256) throw new Z3DistributionError(`the embedded Z3 binary ${manifest.wasm.asset} does not match the checksum in its manifest`);
  return { entry: path.join(directory, Z3_API_FILE), wasmBinary };
};
