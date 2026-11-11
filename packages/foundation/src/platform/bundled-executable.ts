import path from 'node:path';
import { sha256Hex } from '../canonical-json.ts';
import type { FileSystem } from '../node-file-system.ts';
import type { Random } from '../random.ts';

export type BundledExecutableManifest = {
  target: string;
  binary: { asset: string; sha256: string; size: number; name: string };
};

export type BundledExecutableKind = {
  what: string;
  manifestAsset: string;
  folder: string;
  mode: number | undefined;
  failure(message: string): Error;
};

export type BundledExecutablePorts = {
  asset(name: string): Uint8Array;
  executablesRoot: string;
  random: Pick<Random, 'hex'>;
  files: Pick<FileSystem, 'mkdirPrivate' | 'readFile' | 'open' | 'rename' | 'rm'>;
};

const EXCLUSIVE_CREATE = 'wx';

export const BUNDLED_EXECUTABLE_STAGED_INFIX = '.partial-';
export const BUNDLED_EXECUTABLE_STAGED_NAME_BYTES = 8;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const textField = (kind: BundledExecutableKind, record: Record<string, unknown>, key: string, what: string): string => {
  const value = record[key];
  if (typeof value !== 'string' || value === '') throw kind.failure(`the ${kind.what} manifest has no ${what}`);
  return value;
};

export const parseBundledExecutableManifest = (kind: BundledExecutableKind, text: string): BundledExecutableManifest => {
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed)) throw kind.failure(`the ${kind.what} manifest is malformed`);
  const binary = parsed['binary'];
  if (!isRecord(binary)) throw kind.failure(`the ${kind.what} manifest has no binary entry`);
  const sha256 = binary['sha256'];
  if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) throw kind.failure(`the ${kind.what} manifest has no valid binary checksum`);
  const size = binary['size'];
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size <= 0) throw kind.failure(`the ${kind.what} manifest has no valid binary size`);
  const name = textField(kind, binary, 'name', 'binary name');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) throw kind.failure(`the ${kind.what} manifest names its binary with something other than a plain file name`);
  return { target: textField(kind, parsed, 'target', 'target'), binary: { asset: textField(kind, binary, 'asset', 'binary asset'), sha256, size, name } };
};

const matches = async (files: BundledExecutablePorts['files'], file: string, sha256: string): Promise<boolean> => {
  let bytes: Uint8Array;
  try {
    bytes = await files.readFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  return sha256Hex(bytes) === sha256;
};

const writeStaged = async (kind: BundledExecutableKind, files: BundledExecutablePorts['files'], staged: string, binary: Uint8Array): Promise<void> => {
  const handle = await files.open(staged, EXCLUSIVE_CREATE, kind.mode);
  try {
    await handle.writeFile(binary);
  } finally {
    await handle.close();
  }
};

export const ensureBundledExecutable = async (kind: BundledExecutableKind, { asset, executablesRoot, random, files }: BundledExecutablePorts): Promise<string> => {
  const manifest = parseBundledExecutableManifest(kind, new TextDecoder().decode(asset(kind.manifestAsset)));
  const { sha256, size, name } = manifest.binary;
  const directory = path.join(executablesRoot, `${kind.folder}-${sha256.slice(0, 16)}`);
  const final = path.join(directory, name);
  await files.mkdirPrivate(directory);
  if (await matches(files, final, sha256)) return final;
  const binary = asset(manifest.binary.asset);
  if (binary.length !== size || sha256Hex(binary) !== sha256) throw kind.failure(`the embedded ${kind.what} ${manifest.binary.asset} does not match the checksum in its manifest`);
  const staged = `${final}${BUNDLED_EXECUTABLE_STAGED_INFIX}${random.hex(BUNDLED_EXECUTABLE_STAGED_NAME_BYTES)}`;
  try {
    await writeStaged(kind, files, staged, binary);
    await files.rename(staged, final);
  } catch (error) {
    await files.rm(staged);
    throw error;
  }
  if (!(await matches(files, final, sha256))) throw kind.failure(`${final} changed after it was extracted and does not match the embedded ${kind.what}`);
  return final;
};

export const checkedBundledExecutable =
  (kind: BundledExecutableKind, file: string, sha256: string, read: (file: string) => Uint8Array): (() => string) =>
  () => {
    if (sha256Hex(read(file)) !== sha256) throw kind.failure(`${file} does not match the embedded ${kind.what}, so it was not started`);
    return file;
  };
