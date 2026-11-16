import { getAssetKeys, getRawAsset, isSea } from 'node:sea';
import { WINDOWS_KEEPER_MANIFEST_ASSET, ensureBundledWindowsKeeper, hostCheckedWindowsKeeper, hostProcessGroupPort, nodeFileSystem, parseWindowsKeeperManifest, provideWindowsKeeper, resolveLayoutLocks, systemRandom } from '@momonga/foundation';
import type { KeeperPreparation } from '@momonga/foundation';
import type { CliPorts } from '../ports.ts';
import { pathsOf } from '../paths.ts';
import { hostSourceBuiltWindowsKeeper } from '../node-ports.ts';

export type EmbeddedKeeperAssets = { present(name: string): boolean; raw(name: string): Uint8Array };

export const seaKeeperAssets = (): EmbeddedKeeperAssets | undefined =>
  isSea() ? { present: (name) => getAssetKeys().includes(name), raw: (name) => new Uint8Array(getRawAsset(name)) } : undefined;

export const hostLaunchesThroughKeeper = (): boolean => hostProcessGroupPort().keeper !== undefined;

export const provideEmbeddedWindowsKeeper = (
  ports: Pick<CliPorts, 'home' | 'platform' | 'env' | 'interrupt'>,
  assets: EmbeddedKeeperAssets | undefined = seaKeeperAssets(),
  provide: (prepare: KeeperPreparation) => void = provideWindowsKeeper,
  launchesThroughKeeper: () => boolean = hostLaunchesThroughKeeper,
): void => {
  if (!launchesThroughKeeper()) return;
  if (assets === undefined) {
    provide(async () => {
      const paths = await pathsOf(ports);
      return hostSourceBuiltWindowsKeeper(paths.executables, resolveLayoutLocks(paths).mechanism)();
    });
    return;
  }
  if (!assets.present(WINDOWS_KEEPER_MANIFEST_ASSET)) return;
  provide(async () => {
    const paths = await pathsOf(ports);
    const extracted = await ensureBundledWindowsKeeper({ asset: assets.raw, executablesRoot: paths.executables, random: systemRandom, files: nodeFileSystem, lock: resolveLayoutLocks(paths).mechanism });
    const { sha256 } = parseWindowsKeeperManifest(new TextDecoder().decode(assets.raw(WINDOWS_KEEPER_MANIFEST_ASSET))).binary;
    return hostCheckedWindowsKeeper(extracted, sha256);
  });
};
