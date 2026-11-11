import { getAssetKeys, getRawAsset, isSea } from 'node:sea';
import { LINUX_SOCKET_GUARD_MANIFEST_ASSET } from '@momonga/foundation';
import type { KernelLockMechanism } from '@momonga/foundation';
import { hostExtractedLinuxSocketGuard, hostSourceBuiltLinuxSocketGuard } from '../node-ports.ts';

type RuntimeEntry = typeof import('@momonga/runtime/entry');
type SocketGuardSource = NonNullable<Parameters<RuntimeEntry['runRuntimeEntry']>[1]['socketGuard']>;

export type SocketGuardHost = {
  platform: NodeJS.Platform;
  embedded: { present(name: string): boolean; raw(name: string): Uint8Array } | undefined;
  builtFromSource(executablesRoot: string): () => string;
  extracted(asset: (name: string) => Uint8Array, executablesRoot: string, lock: KernelLockMechanism): Promise<string>;
};

const seaAssets = (): SocketGuardHost['embedded'] => (isSea() ? { present: (name) => getAssetKeys().includes(name), raw: (name) => new Uint8Array(getRawAsset(name)) } : undefined);

export const socketGuardSourceOf = ({ platform, embedded, builtFromSource, extracted }: SocketGuardHost): SocketGuardSource | undefined => {
  if (platform !== 'linux') return undefined;
  if (embedded === undefined) {
    return (paths) => {
      const built = builtFromSource(paths.executables);
      return async () => built();
    };
  }
  if (!embedded.present(LINUX_SOCKET_GUARD_MANIFEST_ASSET)) return undefined;
  return (paths, locks) => () => extracted(embedded.raw, paths.executables, locks.mechanism);
};

export const hostSocketGuardSource = (): SocketGuardSource | undefined =>
  socketGuardSourceOf({ platform: process.platform, embedded: seaAssets(), builtFromSource: hostSourceBuiltLinuxSocketGuard, extracted: hostExtractedLinuxSocketGuard });
