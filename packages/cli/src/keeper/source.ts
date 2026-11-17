import path from 'node:path';
import {
  LINUX_SOCKET_GUARD_MANIFEST_ASSET,
  LinuxSocketGuardDistributionError,
  WINDOWS_KEEPER_COMPILER_MISSING_EXIT,
  WINDOWS_KEEPER_MANIFEST_ASSET,
  WindowsKeeperDistributionError,
  checkedLinuxSocketGuard,
  checkedWindowsKeeper,
  claimPathOf,
  ensureBundledLinuxSocketGuard,
  ensureBundledWindowsKeeper,
  lockFormOf,
  nodeFileSystem,
  parseLinuxSocketGuardManifest,
  parseWindowsKeeperManifest,
  sha256Hex,
  sweepLeftovers,
} from '@momonga/foundation';
import type { BundledExecutableManifest, KernelLockMechanism, Random } from '@momonga/foundation';

const WORK_NAME_BYTES = 8;

export type SourceKeeperFiles = {
  exists(file: string): boolean;
  read(file: string): Uint8Array;
};

export type SourceKeeperPorts = {
  script: string;
  executablesRoot: string;
  build(script: string, workDir: string): number | null;
  files: SourceKeeperFiles;
  random: Pick<Random, 'hex'>;
  lock: KernelLockMechanism;
};

export type PrebuiltPorts = {
  builtDirectory: string;
  builder: string;
  executablesRoot: string;
  files: SourceKeeperFiles;
  random: Pick<Random, 'hex'>;
  lock: KernelLockMechanism;
};

type CheckPorts = Pick<SourceKeeperPorts, 'files' | 'executablesRoot' | 'random' | 'lock'>;

type EnsureBundled = typeof ensureBundledWindowsKeeper;

type SourceBuiltHelper = {
  what: string;
  executable: string;
  source: string;
  folder: string;
  manifestAsset: string;
  compiler: string;
  neededBy: string;
  parse(text: string): BundledExecutableManifest;
  ensure: EnsureBundled;
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
  ensure: ensureBundledWindowsKeeper,
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
  ensure: ensureBundledLinuxSocketGuard,
  checked: checkedLinuxSocketGuard,
  failure: (message) => new LinuxSocketGuardDistributionError(message),
};

const checkedFrom = async (helper: SourceBuiltHelper, ports: CheckPorts, built: string): Promise<() => string> => {
  const { files, executablesRoot, random, lock } = ports;
  const manifest = helper.parse(new TextDecoder().decode(files.read(path.join(built, helper.manifestAsset))));
  const { asset, sha256, size } = manifest.binary;
  const binary = files.read(path.join(built, asset));
  if (binary.length !== size || sha256Hex(binary) !== sha256) throw helper.failure(`the ${helper.what} built from ${helper.source} does not match the checksum in its manifest`);
  const final = await helper.ensure({ asset: (entry) => files.read(path.join(built, entry)), executablesRoot, random, files: nodeFileSystem, lock });
  return helper.checked(final, sha256, files.read);
};

const buildChecked = async (helper: SourceBuiltHelper, ports: SourceKeeperPorts, workDir: string): Promise<() => string> => {
  const status = ports.build(ports.script, workDir);
  if (status === WINDOWS_KEEPER_COMPILER_MISSING_EXIT) {
    throw helper.failure(`${helper.compiler} was not found on PATH, so the ${helper.executable} that ${helper.neededBy} needs could not be built from ${helper.source}`);
  }
  if (status !== 0) throw helper.failure(`the ${helper.executable} could not be built from ${helper.source}: the build ended with exit code ${status}`);
  return checkedFrom(helper, ports, path.join(workDir, helper.folder));
};

const builtHelper = async (helper: SourceBuiltHelper, ports: SourceKeeperPorts): Promise<() => string> => {
  const { script, executablesRoot, files, random, lock } = ports;
  if (!files.exists(script)) throw helper.failure(`the ${helper.executable} could not be built for this from-source run: ${script} is missing`);
  await nodeFileSystem.mkdirPrivate(executablesRoot);
  await sweepLeftovers({ directories: [{ directory: executablesRoot, isLeftover: (entry) => entry.startsWith(`${helper.folder}-source-`) }], lock });
  const workDir = path.join(executablesRoot, `${helper.folder}-source-${random.hex(WORK_NAME_BYTES)}`);
  const claim = await lock.claim(claimPathOf(lock, workDir, lockFormOf(lock, 'directory')));
  if (claim.kind !== 'claimed') throw helper.failure(`the work directory of the ${helper.executable} build is claimed by another process`);
  try {
    return await buildChecked(helper, ports, workDir);
  } finally {
    await nodeFileSystem.rm(workDir, { recursive: true });
    claim.lock.dispose();
  }
};

const prebuiltHelper = async (ports: PrebuiltPorts): Promise<() => string> => {
  const built = path.join(ports.builtDirectory, LINUX_SOCKET_GUARD_FROM_SOURCE.folder);
  const manifest = path.join(built, LINUX_SOCKET_GUARD_FROM_SOURCE.manifestAsset);
  if (!ports.files.exists(manifest)) {
    throw new LinuxSocketGuardDistributionError(
      `the socket guard executable is not built: ${manifest} is missing; the packaging step builds it with node ${ports.builder}`,
    );
  }
  return checkedFrom(LINUX_SOCKET_GUARD_FROM_SOURCE, ports, built);
};

const memoized = (prepare: () => Promise<() => string>): (() => Promise<() => string>) => {
  let checked: (() => string) | undefined;
  return async () => {
    checked ??= await prepare();
    return checked;
  };
};

export const sourceBuiltWindowsKeeper = (ports: SourceKeeperPorts): (() => Promise<() => string>) =>
  memoized(() => builtHelper(WINDOWS_KEEPER_FROM_SOURCE, ports));

export const prebuiltLinuxSocketGuard = (ports: PrebuiltPorts): (() => Promise<() => string>) => memoized(() => prebuiltHelper(ports));
