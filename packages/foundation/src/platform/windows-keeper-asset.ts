import { checkedBundledExecutable, ensureBundledExecutable, parseBundledExecutableManifest } from './bundled-executable.ts';
import type { BundledExecutableKind, BundledExecutableManifest, BundledExecutablePorts } from './bundled-executable.ts';

export const WINDOWS_KEEPER_MANIFEST_ASSET = 'windows-keeper-manifest.json';
export const WINDOWS_KEEPER_BINARY_ASSET = 'windows-keeper.exe';

export type WindowsKeeperManifest = BundledExecutableManifest;

export type WindowsKeeperDistributionPorts = BundledExecutablePorts;

export class WindowsKeeperDistributionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WindowsKeeperDistributionError';
  }
}

const WINDOWS_KEEPER: BundledExecutableKind = {
  what: 'keeper',
  manifestAsset: WINDOWS_KEEPER_MANIFEST_ASSET,
  folder: 'windows-keeper',
  mode: undefined,
  failure: (message) => new WindowsKeeperDistributionError(message),
};

export const parseWindowsKeeperManifest = (text: string): WindowsKeeperManifest => parseBundledExecutableManifest(WINDOWS_KEEPER, text);

export const ensureBundledWindowsKeeper = (ports: WindowsKeeperDistributionPorts): Promise<string> => ensureBundledExecutable(WINDOWS_KEEPER, ports);

export const checkedWindowsKeeper = (file: string, sha256: string, read: (file: string) => Uint8Array): (() => string) => checkedBundledExecutable(WINDOWS_KEEPER, file, sha256, read);
