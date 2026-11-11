import path from 'node:path';
import {
  BUNDLED_EXECUTABLE_STAGED_INFIX,
  BUNDLED_EXECUTABLE_STAGED_NAME_BYTES,
  LINUX_SOCKET_GUARD_MANIFEST_ASSET,
  LinuxSocketGuardDistributionError,
  WINDOWS_KEEPER_COMPILER_MISSING_EXIT,
  WINDOWS_KEEPER_MANIFEST_ASSET,
  WindowsKeeperDistributionError,
  checkedLinuxSocketGuard,
  checkedWindowsKeeper,
  parseLinuxSocketGuardManifest,
  parseWindowsKeeperManifest,
  sha256Hex,
} from '@momonga/foundation';
import type { BundledExecutableManifest, Random } from '@momonga/foundation';

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

type SourceBuiltHelper = {
  what: string;
  executable: string;
  source: string;
  folder: string;
  manifestAsset: string;
  compiler: string;
  neededBy: string;
  parse(text: string): BundledExecutableManifest;
  checked(file: string, sha256: string, read: (file: string) => Uint8Array): () => string;
  failure(message: string): Error;
};

const WINDOWS_KEEPER_FROM_SOURCE: SourceBuiltHelper = {
  what: 'keeper',
  executable: 'keeper executable',
  source: 'native/windows-keeper/keeper.c',
  folder: 'windows-keeper',
  manifestAsset: WINDOWS_KEEPER_MANIFEST_ASSET,
  compiler: 'zig',
  neededBy: 'a from-source run on Windows',
  parse: parseWindowsKeeperManifest,
  checked: checkedWindowsKeeper,
  failure: (message) => new WindowsKeeperDistributionError(message),
};

const LINUX_SOCKET_GUARD_FROM_SOURCE: SourceBuiltHelper = {
  what: 'socket guard',
  executable: 'socket guard executable',
  source: 'native/linux-socket-guard/guard.c',
  folder: 'linux-socket-guard',
  manifestAsset: LINUX_SOCKET_GUARD_MANIFEST_ASSET,
  compiler: 'cc',
  neededBy: 'a from-source run on Linux',
  parse: parseLinuxSocketGuardManifest,
  checked: checkedLinuxSocketGuard,
  failure: (message) => new LinuxSocketGuardDistributionError(message),
};

const matches = (files: SourceKeeperFiles, file: string, sha256: string): boolean => files.exists(file) && sha256Hex(files.read(file)) === sha256;

const builtHelper = (helper: SourceBuiltHelper, { script, executablesRoot, build, files, random }: SourceKeeperPorts): (() => string) => {
  if (!files.exists(script)) throw helper.failure(`the ${helper.executable} could not be built for this from-source run: ${script} is missing`);
  files.mkdirPrivate(executablesRoot);
  const workDir = path.join(executablesRoot, `${helper.folder}-source-${random.hex(WORK_NAME_BYTES)}`);
  try {
    const status = build(script, workDir);
    if (status === WINDOWS_KEEPER_COMPILER_MISSING_EXIT) {
      throw helper.failure(`${helper.compiler} was not found on PATH, so the ${helper.executable} that ${helper.neededBy} needs could not be built from ${helper.source}`);
    }
    if (status !== 0) throw helper.failure(`the ${helper.executable} could not be built from ${helper.source}: the build ended with exit code ${status}`);
    const built = path.join(workDir, helper.folder);
    const manifest = helper.parse(new TextDecoder().decode(files.read(path.join(built, helper.manifestAsset))));
    const { asset, sha256, size, name } = manifest.binary;
    const binary = files.read(path.join(built, asset));
    if (binary.length !== size || sha256Hex(binary) !== sha256) throw helper.failure(`the ${helper.what} built from ${helper.source} does not match the checksum in its manifest`);
    const directory = path.join(executablesRoot, `${helper.folder}-${sha256.slice(0, 16)}`);
    const final = path.join(directory, name);
    files.mkdirPrivate(directory);
    if (!matches(files, final, sha256)) {
      const staged = `${final}${BUNDLED_EXECUTABLE_STAGED_INFIX}${random.hex(BUNDLED_EXECUTABLE_STAGED_NAME_BYTES)}`;
      try {
        files.write(staged, binary);
        files.rename(staged, final);
      } catch (error) {
        files.remove(staged);
        throw error;
      }
    }
    return helper.checked(final, sha256, files.read);
  } finally {
    files.remove(workDir);
  }
};

const builtOnFirstNeed = (helper: SourceBuiltHelper, ports: SourceKeeperPorts): (() => string) => {
  let checked: (() => string) | undefined;
  return () => {
    checked ??= builtHelper(helper, ports);
    return checked();
  };
};

export const sourceBuiltWindowsKeeper = (ports: SourceKeeperPorts): (() => string) => builtOnFirstNeed(WINDOWS_KEEPER_FROM_SOURCE, ports);

export const sourceBuiltLinuxSocketGuard = (ports: SourceKeeperPorts): (() => string) => builtOnFirstNeed(LINUX_SOCKET_GUARD_FROM_SOURCE, ports);
