import { getAssetKeys, getRawAsset, isSea } from 'node:sea';
import { LINUX_SOCKET_GUARD_MANIFEST_ASSET } from '@momonga/foundation';
import { hostExtractedLinuxSocketGuard, hostPlatform, hostSourceBuiltLinuxSocketGuard } from '../node-ports.ts';

type RuntimeEntry = typeof import('@momonga/runtime/entry');
type SocketGuardSource = NonNullable<Parameters<RuntimeEntry['runRuntimeEntry']>[1]['socketGuard']>;

export type SocketGuardHost = {
  platform: NodeJS.Platform;
  embedded: { present(name: string): boolean; raw(name: string): Uint8Array } | undefined;
  builtFromSource(executablesRoot: string): () => string;
  extracted(asset: (name: string) => Uint8Array, executablesRoot: string): Promise<string>;
};

const seaAssets = (): SocketGuardHost['embedded'] => (isSea() ? { present: (name) => getAssetKeys().includes(name), raw: (name) => new Uint8Array(getRawAsset(name)) } : undefined);

const SOCKET_GUARD_PLATFORMS: ReadonlySet<NodeJS.Platform> = new Set(['linux']);

export const socketGuardSourceOf = ({ platform, embedded, builtFromSource, extracted }: SocketGuardHost): SocketGuardSource | undefined => {
  if (!SOCKET_GUARD_PLATFORMS.has(platform)) return undefined;
  if (embedded === undefined) {
    return (paths) => {
      const built = builtFromSource(paths.executables);
      return async () => built();
    };
  }
  if (!embedded.present(LINUX_SOCKET_GUARD_MANIFEST_ASSET)) return undefined;
  return (paths) => () => extracted(embedded.raw, paths.executables);
};

export const hostSocketGuardSource = (): SocketGuardSource | undefined =>
  socketGuardSourceOf({ platform: hostPlatform(), embedded: seaAssets(), builtFromSource: hostSourceBuiltLinuxSocketGuard, extracted: hostExtractedLinuxSocketGuard });
