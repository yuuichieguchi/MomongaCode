import { randomBytes } from 'node:crypto';
import { getAssetKeys, getRawAsset, isSea } from 'node:sea';
import { ProbeFailedError, defaultProcessInspector, nodeFileSystem } from '@momonga/foundation';
import type { ProbeOptions, ProcessInspector } from '@momonga/foundation';

type RuntimeEntry = typeof import('@momonga/runtime/entry');
type BundledRipgrepSource = NonNullable<Parameters<RuntimeEntry['runRuntimeEntry']>[1]['bundledRipgrep']>;

const OWNER_SEPARATOR = '.';

export const ownerIdOf = (pid: number, startTime: number): string => `${pid}${OWNER_SEPARATOR}${startTime}`;

export const parseOwnerId = (owner: string): { pid: number; startTime: number } | undefined => {
  const parts = owner.split(OWNER_SEPARATOR);
  if (parts.length !== 2 || !parts.every((part) => /^\d+$/.test(part))) return undefined;
  return { pid: Number(parts[0]), startTime: Number(parts[1]) };
};

export const isOwnerRunningWith =
  (inspector: ProcessInspector) =>
  async (owner: string, options: ProbeOptions): Promise<boolean> => {
    const parsed = parseOwnerId(owner);
    if (parsed === undefined) return true;
    const started = await inspector.startTimeOf(parsed.pid, options);
    if (started.kind === 'gone') return false;
    if (started.kind === 'failed') return true;
    return started.value === parsed.startTime;
  };

export const ownOwnerIdWith = (inspector: ProcessInspector, pid: number): ((options: ProbeOptions) => Promise<string>) => {
  let known: string | undefined;
  return async (options) => {
    if (known !== undefined) return known;
    const started = await inspector.startTimeOf(pid, options);
    if (started.kind === 'failed') throw new ProbeFailedError(`reading the start time of this process (${pid})`, started);
    if (started.kind === 'gone') throw new Error(`this process (${pid}) is not listed by the process inspector`);
    known = ownerIdOf(pid, started.value);
    return known;
  };
};

const randomFraction = (): number => randomBytes(4).readUInt32BE(0) / 0x1_0000_0000;

export const embeddedRipgrepSource = ({ RIPGREP_MANIFEST_ASSET, ensureBundledRipgrep }: Pick<RuntimeEntry, 'RIPGREP_MANIFEST_ASSET' | 'ensureBundledRipgrep'>): BundledRipgrepSource | undefined => {
  if (!isSea() || !getAssetKeys().includes(RIPGREP_MANIFEST_ASSET)) return undefined;
  const inspector = defaultProcessInspector();
  const ownerId = ownOwnerIdWith(inspector, process.pid);
  const isOwnerRunning = isOwnerRunningWith(inspector);
  return (paths) => async (signal) =>
    ensureBundledRipgrep({
      asset: (name) => new Uint8Array(getRawAsset(name)),
      executablesRoot: paths.executables,
      random: randomFraction,
      ownerId: await ownerId({ signal }),
      isOwnerRunning: (owner) => isOwnerRunning(owner, { signal }),
      files: nodeFileSystem,
    });
};
