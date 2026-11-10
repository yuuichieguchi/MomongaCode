import path from 'node:path';
import {
  WINDOWS_KEEPER_COMPILER_MISSING_EXIT,
  WINDOWS_KEEPER_MANIFEST_ASSET,
  WINDOWS_KEEPER_STAGED_INFIX,
  WINDOWS_KEEPER_STAGED_NAME_BYTES,
  WindowsKeeperDistributionError,
  checkedWindowsKeeper,
  parseWindowsKeeperManifest,
  sha256Hex,
} from '@momonga/foundation';
import type { Random } from '@momonga/foundation';

const KEEPER_SOURCE = 'native/windows-keeper/keeper.c';
const BUILT_DIRECTORY = 'windows-keeper';
const WORK_NAME_BYTES = 8;

export type SourceKeeperFiles = {
  exists(file: string): boolean;
  read(file: string): Uint8Array;
  mkdirPrivate(directory: string): void;
  write(file: string, bytes: Uint8Array): void;
  rename(from: string, to: string): void;
  remove(target: string): void;
};

export type SourceKeeperPorts = {
  script: string;
  executablesRoot: string;
  build(script: string, workDir: string): number | null;
  files: SourceKeeperFiles;
  random: Pick<Random, 'hex'>;
};

const matches = (files: SourceKeeperFiles, file: string, sha256: string): boolean => files.exists(file) && sha256Hex(files.read(file)) === sha256;

const builtKeeper = ({ script, executablesRoot, build, files, random }: SourceKeeperPorts): (() => string) => {
  if (!files.exists(script)) throw new WindowsKeeperDistributionError(`the keeper executable could not be built for this from-source run: ${script} is missing`);
  files.mkdirPrivate(executablesRoot);
  const workDir = path.join(executablesRoot, `windows-keeper-source-${random.hex(WORK_NAME_BYTES)}`);
  try {
    const status = build(script, workDir);
    if (status === WINDOWS_KEEPER_COMPILER_MISSING_EXIT) {
      throw new WindowsKeeperDistributionError(`zig was not found on PATH, so the keeper executable that a from-source run on Windows needs could not be built from ${KEEPER_SOURCE}`);
    }
    if (status !== 0) throw new WindowsKeeperDistributionError(`the keeper executable could not be built from ${KEEPER_SOURCE}: the build ended with exit code ${status}`);
    const built = path.join(workDir, BUILT_DIRECTORY);
    const manifest = parseWindowsKeeperManifest(new TextDecoder().decode(files.read(path.join(built, WINDOWS_KEEPER_MANIFEST_ASSET))));
    const { asset, sha256, size, name } = manifest.binary;
    const binary = files.read(path.join(built, asset));
    if (binary.length !== size || sha256Hex(binary) !== sha256) throw new WindowsKeeperDistributionError(`the keeper built from ${KEEPER_SOURCE} does not match the checksum in its manifest`);
    const directory = path.join(executablesRoot, `windows-keeper-${sha256.slice(0, 16)}`);
    const final = path.join(directory, name);
    files.mkdirPrivate(directory);
    if (!matches(files, final, sha256)) {
      const staged = `${final}${WINDOWS_KEEPER_STAGED_INFIX}${random.hex(WINDOWS_KEEPER_STAGED_NAME_BYTES)}`;
      try {
        files.write(staged, binary);
        files.rename(staged, final);
      } catch (error) {
        files.remove(staged);
        throw error;
      }
    }
    return checkedWindowsKeeper(final, sha256, files.read);
  } finally {
    files.remove(workDir);
  }
};

export const sourceBuiltWindowsKeeper = (ports: SourceKeeperPorts): (() => string) => {
  let checked: (() => string) | undefined;
  return () => {
    checked ??= builtKeeper(ports);
    return checked();
  };
};
