import path from 'node:path';
import { sha256Hex } from '../canonical-json.ts';
import type { FileSystem } from '../node-file-system.ts';
import type { Random } from '../random.ts';

export const WINDOWS_KEEPER_MANIFEST_ASSET = 'windows-keeper-manifest.json';
export const WINDOWS_KEEPER_BINARY_ASSET = 'windows-keeper.exe';
export const WINDOWS_KEEPER_STAGED_INFIX = '.partial-';
export const WINDOWS_KEEPER_STAGED_NAME_BYTES = 8;
export const WINDOWS_KEEPER_COMPILER_MISSING_EXIT = 3;

export type WindowsKeeperManifest = {
  target: string;
  binary: { asset: string; sha256: string; size: number; name: string };
};

export type WindowsKeeperDistributionPorts = {
  asset(name: string): Uint8Array;
  executablesRoot: string;
  random: Pick<Random, 'hex'>;
  files: Pick<FileSystem, 'mkdirPrivate' | 'readFile' | 'writeFile' | 'rename' | 'rm'>;
};

export class WindowsKeeperDistributionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WindowsKeeperDistributionError';
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const textField = (record: Record<string, unknown>, key: string, what: string): string => {
  const value = record[key];
  if (typeof value !== 'string' || value === '') throw new WindowsKeeperDistributionError(`the keeper manifest has no ${what}`);
  return value;
};

export const parseWindowsKeeperManifest = (text: string): WindowsKeeperManifest => {
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed)) throw new WindowsKeeperDistributionError('the keeper manifest is malformed');
  const binary = parsed['binary'];
  if (!isRecord(binary)) throw new WindowsKeeperDistributionError('the keeper manifest has no binary entry');
  const sha256 = binary['sha256'];
  if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) throw new WindowsKeeperDistributionError('the keeper manifest has no valid binary checksum');
  const size = binary['size'];
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size <= 0) throw new WindowsKeeperDistributionError('the keeper manifest has no valid binary size');
  const name = textField(binary, 'name', 'binary name');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) throw new WindowsKeeperDistributionError('the keeper manifest names its binary with something other than a plain file name');
  return { target: textField(parsed, 'target', 'target'), binary: { asset: textField(binary, 'asset', 'binary asset'), sha256, size, name } };
};

const matches = async (files: WindowsKeeperDistributionPorts['files'], file: string, sha256: string): Promise<boolean> => {
  let bytes: Uint8Array;
  try {
    bytes = await files.readFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  return sha256Hex(bytes) === sha256;
};

export const ensureBundledWindowsKeeper = async ({ asset, executablesRoot, random, files }: WindowsKeeperDistributionPorts): Promise<string> => {
  const manifest = parseWindowsKeeperManifest(new TextDecoder().decode(asset(WINDOWS_KEEPER_MANIFEST_ASSET)));
  const { sha256, size, name } = manifest.binary;
  const directory = path.join(executablesRoot, `windows-keeper-${sha256.slice(0, 16)}`);
  const final = path.join(directory, name);
  await files.mkdirPrivate(directory);
  if (await matches(files, final, sha256)) return final;
  const binary = asset(manifest.binary.asset);
  if (binary.length !== size || sha256Hex(binary) !== sha256) throw new WindowsKeeperDistributionError(`the embedded keeper ${manifest.binary.asset} does not match the checksum in its manifest`);
  const staged = `${final}${WINDOWS_KEEPER_STAGED_INFIX}${random.hex(WINDOWS_KEEPER_STAGED_NAME_BYTES)}`;
  try {
    await files.writeFile(staged, binary);
    await files.rename(staged, final);
  } catch (error) {
    await files.rm(staged);
    throw error;
  }
  if (!(await matches(files, final, sha256))) throw new WindowsKeeperDistributionError(`${final} changed after it was extracted and does not match the embedded keeper`);
  return final;
};

export const checkedWindowsKeeper =
  (file: string, sha256: string, read: (file: string) => Uint8Array): (() => string) =>
  () => {
    if (sha256Hex(read(file)) !== sha256) throw new WindowsKeeperDistributionError(`${file} does not match the embedded keeper, so it was not started`);
    return file;
  };
