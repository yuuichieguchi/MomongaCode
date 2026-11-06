import path from 'node:path';
import { brotliDecompressSync } from 'node:zlib';
import { sha256Hex } from '@momonga/foundation';
import type { FileSystem } from '@momonga/foundation';

export const RIPGREP_MANIFEST_ASSET = 'ripgrep-manifest.json';
export const RIPGREP_BINARY_ASSET = 'ripgrep.br';
export const RIPGREP_NOTICES_ASSET = 'ripgrep-notices.txt';
export const RIPGREP_NOTICE_FILE = 'NOTICE.txt';
export const RIPGREP_STAGED_PREFIX = 'rg.partial-';
export const RIPGREP_REPLACEMENT = 'replaceFile';
export const RIPGREP_RESOLUTION_STEPS = ['start', 'hash', 'decompress', 'rename', 'rehash', 'checked', 'staged'] as const;
export const RIPGREP_EXECUTABLE_MODE = 0o700;
export const RIPGREP_DIRECTORY_MODE = 0o700;

export type RipgrepResolutionStep = (typeof RIPGREP_RESOLUTION_STEPS)[number];

export type RipgrepManifest = {
  version: string;
  target: string;
  binary: { asset: string; sha256: string; size: number; name: string };
  notices: { asset: string; sha256: string };
};

export type RipgrepEntryKind = 'file' | 'directory' | 'symlink' | 'other' | 'absent';

export type RipgrepDistributionFiles = Pick<FileSystem, 'lstat' | 'mkdir' | 'open' | 'readFile' | 'rename' | 'rm' | 'readdir'>;

export type RipgrepDistributionPorts = {
  asset(name: string): Uint8Array;
  executablesRoot: string;
  random(): number;
  ownerId: string;
  isOwnerRunning(owner: string): Promise<boolean>;
  files: RipgrepDistributionFiles;
};

export type BundledRipgrep = { path: string; version: string; release(): Promise<void> };

export class RipgrepDistributionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RipgrepDistributionError';
  }
}

const IN_USE_RENAME_CODES: readonly string[] = ['EBUSY', 'EPERM', 'EACCES', 'ETXTBSY'];

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const textField = (record: Record<string, unknown>, key: string, what: string): string => {
  const value = record[key];
  if (typeof value !== 'string' || value === '') throw new RipgrepDistributionError(`the ripgrep manifest has no ${what}`);
  return value;
};

const hashField = (record: Record<string, unknown>, key: string, what: string): string => {
  const value = record[key];
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) throw new RipgrepDistributionError(`the ripgrep manifest has no valid ${what}`);
  return value;
};

const recordField = (record: Record<string, unknown>, key: string, what: string): Record<string, unknown> => {
  const value = record[key];
  if (!isRecord(value)) throw new RipgrepDistributionError(`the ripgrep manifest has no ${what}`);
  return value;
};

export const parseRipgrepManifest = (text: string): RipgrepManifest => {
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed)) throw new RipgrepDistributionError('the ripgrep manifest is malformed');
  const binary = recordField(parsed, 'binary', 'binary entry');
  const notices = recordField(parsed, 'notices', 'notices entry');
  const size = binary['size'];
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size <= 0) throw new RipgrepDistributionError('the ripgrep manifest has no valid binary size');
  return {
    version: textField(parsed, 'version', 'version'),
    target: textField(parsed, 'target', 'target'),
    binary: {
      asset: textField(binary, 'asset', 'binary asset'),
      sha256: hashField(binary, 'sha256', 'binary checksum'),
      size,
      name: textField(binary, 'name', 'binary name'),
    },
    notices: { asset: textField(notices, 'asset', 'notices asset'), sha256: hashField(notices, 'sha256', 'notices checksum') },
  };
};

export const ripgrepDirectoryName = (manifest: RipgrepManifest): string => `ripgrep-${manifest.version}-${manifest.binary.sha256.slice(0, 16)}`;

export const stagedOwnerOf = (name: string): string | undefined => {
  if (!name.startsWith(RIPGREP_STAGED_PREFIX)) return undefined;
  const [owner] = name.slice(RIPGREP_STAGED_PREFIX.length).split('-');
  return owner === undefined || owner === '' ? undefined : owner;
};

const errnoOf = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | undefined)?.code;

const kindOf = async (files: RipgrepDistributionFiles, target: string): Promise<RipgrepEntryKind> => {
  let stat: Awaited<ReturnType<RipgrepDistributionFiles['lstat']>>;
  try {
    stat = await files.lstat(target);
  } catch (error) {
    if (errnoOf(error) === 'ENOENT') return 'absent';
    throw error;
  }
  if (stat.isFile()) return 'file';
  if (stat.isDirectory()) return 'directory';
  if (stat.isSymbolicLink()) return 'symlink';
  return 'other';
};

const writeExclusive = async (files: RipgrepDistributionFiles, file: string, bytes: Uint8Array, mode: number): Promise<void> => {
  const handle = await files.open(file, 'wx', mode);
  try {
    await handle.writeFile(bytes);
  } finally {
    await handle.close();
  }
};

type Resolution = {
  readonly ports: RipgrepDistributionPorts;
  readonly manifest: RipgrepManifest;
  readonly directory: string;
  readonly final: string;
};

type StagedStep = 'rename' | 'staged';

type ResolutionState =
  | { step: Exclude<RipgrepResolutionStep, StagedStep> }
  | { step: StagedStep; staged: string };

const NO_RELEASE = async (): Promise<void> => undefined;

const sweepStaleStaged = async ({ ports, directory }: Resolution): Promise<void> => {
  for (const name of await ports.files.readdir(directory)) {
    const owner = stagedOwnerOf(name);
    if (owner === undefined) continue;
    if (!(await ports.isOwnerRunning(owner))) await ports.files.rm(path.join(directory, name));
  }
};

const matches = async (resolution: Resolution, file: string): Promise<boolean> => sha256Hex(await resolution.ports.files.readFile(file)) === resolution.manifest.binary.sha256;

const verifiedEmbedded = (resolution: Resolution): { binary: Uint8Array; notices: Uint8Array } => {
  const { ports, manifest } = resolution;
  const binary = new Uint8Array(brotliDecompressSync(ports.asset(manifest.binary.asset)));
  if (binary.length !== manifest.binary.size || sha256Hex(binary) !== manifest.binary.sha256) {
    throw new RipgrepDistributionError(`the embedded ripgrep ${manifest.binary.asset} does not match the checksum in its manifest`);
  }
  const notices = ports.asset(manifest.notices.asset);
  if (sha256Hex(notices) !== manifest.notices.sha256) throw new RipgrepDistributionError(`the embedded ripgrep notices ${manifest.notices.asset} do not match the checksum in their manifest`);
  return { binary, notices };
};

const stagedName = (ports: RipgrepDistributionPorts, suffix: string): string =>
  `${RIPGREP_STAGED_PREFIX}${ports.ownerId}-${Math.floor(ports.random() * 0xffffffff).toString(16)}${suffix}`;

const writeStaged = async (resolution: Resolution, bytes: Uint8Array, suffix: string): Promise<string> => {
  const file = path.join(resolution.directory, stagedName(resolution.ports, suffix));
  try {
    await writeExclusive(resolution.ports.files, file, bytes, RIPGREP_EXECUTABLE_MODE);
  } catch (error) {
    await resolution.ports.files.rm(file);
    throw error;
  }
  return file;
};

const placeNotice = async (resolution: Resolution, notices: Uint8Array): Promise<void> => {
  const staged = await writeStaged(resolution, notices, '.notice');
  try {
    await resolution.ports.files.rename(staged, path.join(resolution.directory, RIPGREP_NOTICE_FILE));
  } catch (error) {
    await resolution.ports.files.rm(staged);
    throw error;
  }
};

const nextState = async (state: ResolutionState, resolution: Resolution): Promise<ResolutionState | BundledRipgrep> => {
  const { ports, final } = resolution;
  switch (state.step) {
    case 'start': {
      await ports.files.mkdir(resolution.directory, RIPGREP_DIRECTORY_MODE);
      await sweepStaleStaged(resolution);
      const kind = await kindOf(ports.files, final);
      if (kind === 'absent') return { step: 'decompress' };
      if (kind !== 'file') throw new RipgrepDistributionError(`${final} is not a regular file; remove it so that the embedded ripgrep is extracted again`);
      return { step: 'hash' };
    }
    case 'hash':
      return { step: (await matches(resolution, final)) ? 'checked' : 'decompress' };
    case 'decompress': {
      const { binary, notices } = verifiedEmbedded(resolution);
      const staged = await writeStaged(resolution, binary, '');
      try {
        await placeNotice(resolution, notices);
      } catch (error) {
        await ports.files.rm(staged);
        throw error;
      }
      return { step: 'rename', staged };
    }
    case 'rename':
      try {
        await ports.files.rename(state.staged, final);
      } catch (error) {
        const code = errnoOf(error);
        if (code !== undefined && IN_USE_RENAME_CODES.includes(code) && (await matches(resolution, state.staged))) return { step: 'staged', staged: state.staged };
        await ports.files.rm(state.staged);
        throw error;
      }
      return { step: 'rehash' };
    case 'rehash':
      if (!(await matches(resolution, final))) throw new RipgrepDistributionError(`${final} changed after it was extracted and does not match the embedded ripgrep`);
      return { step: 'checked' };
    case 'checked':
      return { path: final, version: resolution.manifest.version, release: NO_RELEASE };
    case 'staged': {
      const { staged } = state;
      return { path: staged, version: resolution.manifest.version, release: () => ports.files.rm(staged) };
    }
  }
};

export const ensureBundledRipgrep = async (ports: RipgrepDistributionPorts): Promise<BundledRipgrep> => {
  const manifest = parseRipgrepManifest(new TextDecoder().decode(ports.asset(RIPGREP_MANIFEST_ASSET)));
  const directory = path.join(ports.executablesRoot, ripgrepDirectoryName(manifest));
  const resolution: Resolution = { ports, manifest, directory, final: path.join(directory, manifest.binary.name) };
  let state: ResolutionState | BundledRipgrep = { step: 'start' };
  while ('step' in state) state = await nextState(state, resolution);
  return state;
};
