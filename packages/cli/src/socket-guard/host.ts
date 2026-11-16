import { getAssetKeys, getRawAsset, isSea } from 'node:sea';
import { LINUX_SOCKET_GUARD_MANIFEST_ASSET } from '@momonga/foundation';
import type { KernelLockMechanism } from '@momonga/foundation';
import { hostExtractedLinuxSocketGuard, hostPlatform, hostPrebuiltLinuxSocketGuard } from '../node-ports.ts';

type RuntimeEntry = typeof import('@momonga/runtime/entry');
type SocketGuardSource = NonNullable<Parameters<RuntimeEntry['runRuntimeEntry']>[1]['socketGuard']>;

export type SocketGuardHost = {
  platform: NodeJS.Platform;
  embedded: { present(name: string): boolean; raw(name: string): Uint8Array } | undefined;
  prebuilt(executablesRoot: string, lock: KernelLockMechanism): () => Promise<() => string>;
  extracted(asset: (name: string) => Uint8Array, executablesRoot: string, lock: KernelLockMechanism): Promise<string>;
};

const seaAssets = (): SocketGuardHost['embedded'] => (isSea() ? { present: (name) => getAssetKeys().includes(name), raw: (name) => new Uint8Array(getRawAsset(name)) } : undefined);

const SOCKET_GUARD_PLATFORMS: ReadonlySet<NodeJS.Platform> = new Set(['linux']);

export const socketGuardSourceOf = ({ platform, embedded, prebuilt, extracted }: SocketGuardHost): SocketGuardSource | undefined => {
  if (!SOCKET_GUARD_PLATFORMS.has(platform)) return undefined;
  if (embedded === undefined) {
    return (paths, locks) => {
      const built = prebuilt(paths.executables, locks.mechanism);
      return async () => (await built())();
    };
  }
  if (!embedded.present(LINUX_SOCKET_GUARD_MANIFEST_ASSET)) return undefined;
  return (paths, locks) => () => extracted(embedded.raw, paths.executables, locks.mechanism);
};

export const hostSocketGuardSource = (): SocketGuardSource | undefined =>
  socketGuardSourceOf({ platform: hostPlatform(), embedded: seaAssets(), prebuilt: hostPrebuiltLinuxSocketGuard, extracted: hostExtractedLinuxSocketGuard });
