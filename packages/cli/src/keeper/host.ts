import { getAssetKeys, getRawAsset, isSea } from 'node:sea';
import { WINDOWS_KEEPER_MANIFEST_ASSET, ensureBundledWindowsKeeper, hostProcessGroupPort, nodeFileSystem, parseWindowsKeeperManifest, provideCheckedWindowsKeeper, provideWindowsKeeper, systemRandom } from '@momonga/foundation';
import type { CliPorts } from '../ports.ts';
import { pathsOf } from '../paths.ts';
import { hostSourceBuiltWindowsKeeper } from '../node-ports.ts';

export type EmbeddedKeeperAssets = { present(name: string): boolean; raw(name: string): Uint8Array };

export const seaKeeperAssets = (): EmbeddedKeeperAssets | undefined =>
  isSea() ? { present: (name) => getAssetKeys().includes(name), raw: (name) => new Uint8Array(getRawAsset(name)) } : undefined;

export const hostLaunchesThroughKeeper = (): boolean => hostProcessGroupPort().keeper !== undefined;

export const provideEmbeddedWindowsKeeper = async (
  ports: Pick<CliPorts, 'home' | 'platform' | 'env' | 'interrupt'>,
  assets: EmbeddedKeeperAssets | undefined = seaKeeperAssets(),
  provide: (file: string, sha256: string) => void = provideCheckedWindowsKeeper,
  provideSource: (executable: () => string) => void = provideWindowsKeeper,
  launchesThroughKeeper: () => boolean = hostLaunchesThroughKeeper,
): Promise<void> => {
  if (!launchesThroughKeeper()) return;
  if (assets === undefined) {
    provideSource(hostSourceBuiltWindowsKeeper((await pathsOf(ports)).executables));
    return;
  }
  if (!assets.present(WINDOWS_KEEPER_MANIFEST_ASSET)) return;
  const paths = await pathsOf(ports);
  const extracted = await ensureBundledWindowsKeeper({ asset: assets.raw, executablesRoot: paths.executables, random: systemRandom, files: nodeFileSystem });
  const { sha256 } = parseWindowsKeeperManifest(new TextDecoder().decode(assets.raw(WINDOWS_KEEPER_MANIFEST_ASSET))).binary;
  provide(extracted, sha256);
};
