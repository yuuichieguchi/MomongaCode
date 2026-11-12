import path from 'node:path';
import { sha256Hex } from '../canonical-json.ts';
import { parseShippedManifest } from '../json.ts';
import { sweepLeftovers } from '../leftover-sweep.ts';
import { createLockedEntry } from '../locked-entry.ts';
import type { FileSystem } from '../node-file-system.ts';
import type { Random } from '../random.ts';
import type { KernelLockMechanism } from './kernel-lock.ts';
import { replaceExecutable } from './replace-executable.ts';

export type BundledExecutableManifest = {
  target: string;
  binary: { asset: string; sha256: string; size: number; name: string };
};

export type BundledExecutableKind = {
  what: string;
  manifestAsset: string;
  folder: string;
  failure(message: string): Error;
};

export type BundledExecutablePorts = {
  asset(name: string): Uint8Array;
  executablesRoot: string;
  random: Pick<Random, 'hex'>;
  files: Pick<FileSystem, 'mkdirPrivate' | 'readFile' | 'open' | 'rename' | 'rm' | 'readdir'>;
  lock: KernelLockMechanism;
};

export const BUNDLED_EXECUTABLE_STAGED_INFIX = '.partial-';
export const BUNDLED_EXECUTABLE_STAGED_NAME_BYTES = 8;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const textField = (kind: BundledExecutableKind, record: Record<string, unknown>, key: string, what: string): string => {
  const value = record[key];
  if (typeof value !== 'string' || value === '') throw kind.failure(`the ${kind.what} manifest has no ${what}`);
  return value;
};

export const parseBundledExecutableManifest = (kind: BundledExecutableKind, text: string): BundledExecutableManifest => {
  const parsed = parseShippedManifest(text, kind.manifestAsset, kind.failure);
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

const BUNDLED_EXECUTABLE_MODE = 0o700;

const stagedPrefixOf = (name: string): string => `${name}${BUNDLED_EXECUTABLE_STAGED_INFIX}`;

const sweepStaged = async ({ files, lock }: BundledExecutablePorts, directory: string, name: string): Promise<void> => {
  await sweepLeftovers({
    directories: [{ directory, isLeftover: (entry) => entry.startsWith(stagedPrefixOf(name)) }],
    lock,
    files: { readdir: (entries) => files.readdir(entries), rm: (entry) => files.rm(entry, { recursive: true }) },
  });
};

const stagedNameBeside = (final: string, random: BundledExecutablePorts['random']): string => path.join(path.dirname(final), `${stagedPrefixOf(path.basename(final))}${random.hex(BUNDLED_EXECUTABLE_STAGED_NAME_BYTES)}`);

const placeStaged = async ({ files, lock, random }: BundledExecutablePorts, final: string, binary: Uint8Array): Promise<void> => {
  const file = stagedNameBeside(final, random);
  const staged = await createLockedEntry(files, lock, file, BUNDLED_EXECUTABLE_MODE);
  try {
    try {
      await staged.handle.writeFile(binary);
    } finally {
      await staged.handle.close();
    }
    staged.assertStillNamed();
    await replaceExecutable((from, to) => files.rename(from, to), lock, staged.path, final, stagedNameBeside(final, random));
  } catch (error) {
    await staged.remove();
    throw error;
  }
  staged.finish();
};

export const ensureBundledExecutable = async (kind: BundledExecutableKind, ports: BundledExecutablePorts): Promise<string> => {
  const { asset, executablesRoot, files } = ports;
  const manifest = parseBundledExecutableManifest(kind, new TextDecoder().decode(asset(kind.manifestAsset)));
  const { sha256, size, name } = manifest.binary;
  const directory = path.join(executablesRoot, `${kind.folder}-${sha256.slice(0, 16)}`);
  const final = path.join(directory, name);
  await files.mkdirPrivate(directory);
  await sweepStaged(ports, directory, name);
  if (await matches(files, final, sha256)) return final;
  const binary = asset(manifest.binary.asset);
  if (binary.length !== size || sha256Hex(binary) !== sha256) throw kind.failure(`the embedded ${kind.what} ${manifest.binary.asset} does not match the checksum in its manifest`);
  await placeStaged(ports, final, binary);
  if (!(await matches(files, final, sha256))) throw kind.failure(`${final} changed after it was extracted and does not match the embedded ${kind.what}`);
  return final;
};

export const checkedBundledExecutable =
  (kind: BundledExecutableKind, file: string, sha256: string, read: (file: string) => Uint8Array): (() => string) =>
  () => {
    if (sha256Hex(read(file)) !== sha256) throw kind.failure(`${file} does not match the embedded ${kind.what}, so it was not started`);
    return file;
  };
