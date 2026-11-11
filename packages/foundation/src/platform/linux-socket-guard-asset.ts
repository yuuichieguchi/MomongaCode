import { checkedBundledExecutable, ensureBundledExecutable, parseBundledExecutableManifest } from './bundled-executable.ts';
import type { BundledExecutableKind, BundledExecutableManifest, BundledExecutablePorts } from './bundled-executable.ts';

export const LINUX_SOCKET_GUARD_MANIFEST_ASSET = 'linux-socket-guard-manifest.json';
export const LINUX_SOCKET_GUARD_BINARY_ASSET = 'linux-socket-guard';
export const LINUX_SOCKET_GUARD_BINARY_NAME = 'momonga-socket-guard';

export class LinuxSocketGuardDistributionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LinuxSocketGuardDistributionError';
  }
}

const LINUX_SOCKET_GUARD: BundledExecutableKind = {
  what: 'socket guard',
  manifestAsset: LINUX_SOCKET_GUARD_MANIFEST_ASSET,
  folder: 'linux-socket-guard',
  failure: (message) => new LinuxSocketGuardDistributionError(message),
};

export const parseLinuxSocketGuardManifest = (text: string): BundledExecutableManifest => parseBundledExecutableManifest(LINUX_SOCKET_GUARD, text);

export const ensureBundledLinuxSocketGuard = (ports: BundledExecutablePorts): Promise<string> => ensureBundledExecutable(LINUX_SOCKET_GUARD, ports);

export const checkedLinuxSocketGuard = (file: string, sha256: string, read: (file: string) => Uint8Array): (() => string) => checkedBundledExecutable(LINUX_SOCKET_GUARD, file, sha256, read);
