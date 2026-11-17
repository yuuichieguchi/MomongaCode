import type { FileSystem } from './node-file-system.ts';
import type fs from 'node:fs';
import path from 'node:path';
import { listGenerationNumbers, lockReadsHeld } from './generation-registry.ts';
import { sweepLeftovers } from './leftover-sweep.ts';
import type { LeftoverFiles } from './leftover-sweep.ts';
import {
  GENERATION_TARGETS_DIRECTORY,
  generationLayout,
  generationMarkerDirectories,
  generationMemberOf,
  generationOfDirectoryName,
  generationSpawnScratch,
  runLeftovers,
} from './momonga-paths.ts';
import type { GenerationLayout, GenerationMember, MarkerKind, MomongaPaths } from './momonga-paths.ts';
import type { HeldKernelLock, KernelLockMechanism } from './platform/kernel-lock.ts';
import { lockPathNameOf } from './platform/lock-form.ts';
import { readAttemptRecord, readMarkerGroup } from './platform/marker-record.ts';
import type { RetryKind } from './platform/marker-record.ts';
import { survivorNoticeText } from './process-markers.ts';
import { nodeFileSystem } from './node-file-system.ts';
import { systemWaitTiming } from './system-timing.ts';
import { sleep } from './timing.ts';

const GENERATION_YIELD_MS = 0;

export const GENERATION_REAPER_STEP_ACTIONS = {
  'claim-dead': 'ClaimDead',
  'reap-markers': 'ReapMarkers',
  'claim-members': 'ClaimInstance',
  'remove-members': 'RemoveInstance',
  'remove-directory': 'RemoveDir',
} as const;

export type GenerationReaperStep = keyof typeof GENERATION_REAPER_STEP_ACTIONS;

export const GENERATION_REAPER_STEPS: readonly GenerationReaperStep[] = ['claim-dead', 'reap-markers', 'claim-members', 'remove-members', 'remove-directory'];

export const GENERATION_REAPER_OCCASION: RetryKind = 'sweep';

export const GENERATION_MARKER_REAP_ORDER: readonly MarkerKind[] = ['daemons', 'mcp', 'tools', 'targets'];

export const GENERATION_MARKER_LABELS: Readonly<Record<MarkerKind, string>> = { daemons: 'daemon', mcp: 'mcp', tools: 'tool', targets: 'managed server' };

export type GenerationReaperFiles = Pick<FileSystem, 'readdir'> & {
  markerFiles(directory: string): Promise<string[]>;
  mkdir(directory: string): Promise<void>;
  unlink(file: string): Promise<void>;
  rmdir(directory: string): Promise<void>;
  removeTree(directory: string): Promise<void>;
};

export type GenerationMarkerReap = { generation: number; kind: MarkerKind; directory: string; signal: AbortSignal };

export type GenerationReaperOptions = {
  paths: MomongaPaths;
  lock: KernelLockMechanism;
  signal: AbortSignal;
  warn(message: string): void;
  reapMarkers(request: GenerationMarkerReap): Promise<void>;
  files?: GenerationReaperFiles;
};

export type GenerationReaperResult = { removed: readonly number[]; kept: readonly number[]; busy: boolean };

const codeOf = (error: unknown): string | undefined => (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : undefined);

const reasonOf = (error: unknown): string => codeOf(error) ?? (error instanceof Error ? error.message : String(error));

const missing = (error: unknown): boolean => codeOf(error) === 'ENOENT';

const markerFilesUnder = async (directory: string): Promise<string[]> => {
  let entries: fs.Dirent[];
  try {
    entries = await nodeFileSystem.readdirEntries(directory);
  } catch (error) {
    if (missing(error)) return [];
    throw error;
  }
  const found: string[] = [];
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...(await markerFilesUnder(target)));
    else found.push(target);
  }
  return found;
};

export const nodeGenerationReaperFiles: GenerationReaperFiles = {
  readdir: (directory) => nodeFileSystem.readdir(directory),
  markerFiles: markerFilesUnder,
  mkdir: (directory) => nodeFileSystem.makeDirectory(directory, 0o700),
  unlink: (file) => nodeFileSystem.rm(file),
  rmdir: async (directory) => {
    try {
      await nodeFileSystem.removeEmptyDirectory(directory);
    } catch (error) {
      if (!missing(error)) throw error;
    }
  },
  removeTree: (directory) => nodeFileSystem.rm(directory, { recursive: true }),
};

class EntryKept extends Error {
  readonly entry: string;
  readonly reason: string;

  constructor(entry: string, reason: string) {
    super(`leftover cleanup kept ${entry}: ${reason}`);
    this.name = 'EntryKept';
    this.entry = entry;
    this.reason = reason;
  }
}

const keptMessage = (entry: string, reason: string): string => new EntryKept(entry, reason).message;

const LOCK_HELD = 'its lock is held';
const UNKNOWN_ENTRY = 'this version does not know the entry';
const NOT_EMPTY = 'ENOTEMPTY';
const UNPROVED = 'no lock proves it unused';
const NOT_STOPPED = 'its process was not stopped';

const INSTANCE_LOCK_SUFFIX = '.lock';
const INSTANCE_SOCKET_SUFFIX = '.sock';

const onEntry = async <Result>(entry: string, work: () => Promise<Result> | Result): Promise<Result> => {
  try {
    return await work();
  } catch (error) {
    throw error instanceof EntryKept ? error : new EntryKept(entry, reasonOf(error));
  }
};

const namesIn = async (files: GenerationReaperFiles, directory: string): Promise<string[]> => {
  try {
    return (await files.readdir(directory)).sort();
  } catch (error) {
    if (missing(error)) return [];
    throw error;
  }
};

const memberOf = (lock: KernelLockMechanism, name: string): GenerationMember | undefined => generationMemberOf(name) ?? generationMemberOf(lockPathNameOf(lock, name));

type Claim = { lockPath: string; held: HeldKernelLock };

type InstanceClaim = Claim & { socket: string };

type Work = {
  readonly generation: number;
  readonly hasDirectory: boolean;
  readonly layout: GenerationLayout;
  readonly targets: string;
  readonly scratch: string;
  supervisor: Claim | undefined;
  readonly others: Claim[];
  readonly instances: InstanceClaim[];
};

type Pass = { readonly options: GenerationReaperOptions; readonly files: GenerationReaperFiles; readonly sweepFiles: LeftoverFiles };

type StepOutcome = 'done' | 'live' | 'busy' | 'kept';

type StepRunner = (pass: Pass, work: Work) => Promise<StepOutcome>;

const claimOrKeep = async (pass: Pass, lockPath: string): Promise<Claim> => {
  const outcome = await onEntry(lockPath, () => pass.options.lock.claim(lockPath));
  if (outcome.kind === 'held') throw new EntryKept(lockPath, LOCK_HELD);
  return { lockPath, held: outcome.lock };
};

const dispose = (claim: Claim): Promise<void> => onEntry(claim.lockPath, () => claim.held.dispose());

const readsLive = async (pass: Pass, layout: GenerationLayout): Promise<boolean> => {
  const probe = { lock: pass.options.lock, onProbeFailure: (lockPath: string, error: unknown) => pass.options.warn(keptMessage(lockPath, reasonOf(error))) };
  return (await lockReadsHeld(layout.locks.supervisor, probe)) || (await lockReadsHeld(layout.startingLock, probe));
};

const claimDead: StepRunner = async (pass, work) => {
  const { lock, paths } = pass.options;
  if (await readsLive(pass, work.layout)) return 'live';
  const gate = await lock.claim(paths.generationLock);
  if (gate.kind === 'held') return 'busy';
  try {
    if (await readsLive(pass, work.layout)) return 'live';
    if (!work.hasDirectory) await pass.files.mkdir(work.layout.dir);
    const starting = await lock.claim(work.layout.startingLock);
    if (starting.kind === 'held') return 'live';
    work.others.push({ lockPath: work.layout.startingLock, held: starting.lock });
    const supervisor = await lock.claim(work.layout.locks.supervisor);
    if (supervisor.kind === 'held') return 'live';
    work.supervisor = { lockPath: work.layout.locks.supervisor, held: supervisor.lock };
    return 'done';
  } finally {
    gate.lock.release();
  }
};

const survivorWarning = async (marker: string, kind: MarkerKind): Promise<string | undefined> => {
  let record: Awaited<ReturnType<typeof readAttemptRecord>>;
  try {
    record = await readAttemptRecord(marker);
  } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  }
  if (record.ignored) return undefined;
  return record.spent[GENERATION_REAPER_OCCASION] ? survivorNoticeText(GENERATION_MARKER_LABELS[kind], path.basename(marker), await readMarkerGroup(marker)) : keptMessage(marker, NOT_STOPPED);
};

const reapMarkers: StepRunner = async (pass, work) => {
  const { options, files } = pass;
  const directories = generationMarkerDirectories(options.paths, work.generation);
  for (const kind of GENERATION_MARKER_REAP_ORDER) {
    if (options.signal.aborted) return 'kept';
    await onEntry(directories[kind], () => options.reapMarkers({ generation: work.generation, kind, directory: directories[kind], signal: options.signal }));
  }
  if (options.signal.aborted) return 'kept';
  let survivors = 0;
  for (const kind of GENERATION_MARKER_REAP_ORDER) {
    for (const marker of await onEntry(directories[kind], () => files.markerFiles(directories[kind]))) {
      const warning = await onEntry(marker, () => survivorWarning(marker, kind));
      if (warning === undefined) continue;
      survivors += 1;
      options.warn(warning);
    }
  }
  return survivors > 0 ? 'kept' : 'done';
};

const instanceLockPaths = (lock: KernelLockMechanism, targets: string, names: readonly string[]): string[] =>
  [...new Set(names.map((name) => lockPathNameOf(lock, name)).filter((name) => name.endsWith(INSTANCE_LOCK_SUFFIX)))].map((name) => path.join(targets, name));

const socketOfInstance = (lockPath: string): string => `${lockPath.slice(0, -INSTANCE_LOCK_SUFFIX.length)}${INSTANCE_SOCKET_SUFFIX}`;

const claimMembers: StepRunner = async (pass, work) => {
  const { options, files } = pass;
  const { layout } = work;
  for (const lockPath of [layout.locks.runtime, layout.locks.gateway]) work.others.push(await claimOrKeep(pass, lockPath));
  const instanceNames = await onEntry(work.targets, () => namesIn(files, work.targets));
  for (const lockPath of instanceLockPaths(options.lock, work.targets, instanceNames)) {
    work.instances.push({ ...(await claimOrKeep(pass, lockPath)), socket: socketOfInstance(lockPath) });
  }
  for (const name of await onEntry(layout.dir, () => namesIn(files, layout.dir))) {
    const entry = path.join(layout.dir, name);
    const member = memberOf(options.lock, name);
    if (member === undefined) throw new EntryKept(entry, UNKNOWN_ENTRY);
    if (member.removal === 'when-empty' && (await onEntry(entry, () => namesIn(files, entry))).length > 0) throw new EntryKept(entry, NOT_EMPTY);
  }
  const swept = await sweepLeftovers({ directories: [{ directory: work.scratch, isLeftover: () => true }], lock: options.lock, files: pass.sweepFiles, warn: options.warn });
  const unproved = swept.kept[0];
  if (unproved !== undefined) throw new EntryKept(unproved, UNPROVED);
  return 'done';
};

const removeMembers: StepRunner = async (pass, work) => {
  const { files } = pass;
  await onEntry(work.layout.markers, () => files.removeTree(work.layout.markers));
  for (const instance of work.instances) {
    await onEntry(instance.socket, () => files.unlink(instance.socket));
    await dispose(instance);
  }
  await onEntry(work.targets, () => files.removeTree(work.targets));
  return 'done';
};

const removeDirectory: StepRunner = async (pass, work) => {
  const { options, files } = pass;
  const { layout, supervisor } = work;
  if (supervisor === undefined) return 'kept';
  const claimed = new Set([supervisor, ...work.others].map((claim) => path.basename(claim.lockPath)));
  for (const name of await onEntry(layout.dir, () => namesIn(files, layout.dir))) {
    if (claimed.has(lockPathNameOf(options.lock, name))) continue;
    const entry = path.join(layout.dir, name);
    const member = memberOf(options.lock, name);
    if (member === undefined) throw new EntryKept(entry, UNKNOWN_ENTRY);
    await onEntry(entry, () => (member.kind === 'directory' ? files.rmdir(entry) : files.unlink(entry)));
  }
  await onEntry(work.scratch, () => files.rmdir(work.scratch));
  for (const claim of work.others.filter((other) => other.lockPath !== layout.startingLock)) await dispose(claim);
  for (const claim of work.others.filter((other) => other.lockPath === layout.startingLock)) await dispose(claim);
  await dispose(supervisor);
  await onEntry(layout.dir, () => files.rmdir(layout.dir));
  return 'done';
};

const STEP_RUNNERS: Readonly<Record<GenerationReaperStep, StepRunner>> = {
  'claim-dead': claimDead,
  'reap-markers': reapMarkers,
  'claim-members': claimMembers,
  'remove-members': removeMembers,
  'remove-directory': removeDirectory,
};

type GenerationOutcome = 'removed' | 'kept' | 'live' | 'busy' | 'interrupted';

const reapGeneration = async (pass: Pass, generation: number, hasDirectory: boolean): Promise<GenerationOutcome> => {
  const { paths, signal, warn } = pass.options;
  const layout = generationLayout(path.dirname(paths.root), generation);
  const work: Work = {
    generation,
    hasDirectory,
    layout,
    targets: path.join(layout.dir, GENERATION_TARGETS_DIRECTORY),
    scratch: generationSpawnScratch(paths, generation),
    supervisor: undefined,
    others: [],
    instances: [],
  };
  try {
    for (const step of GENERATION_REAPER_STEPS) {
      if (signal.aborted) return 'interrupted';
      const outcome = await STEP_RUNNERS[step](pass, work);
      if (signal.aborted && outcome !== 'done') return 'interrupted';
      if (outcome !== 'done') return outcome;
    }
    return 'removed';
  } catch (error) {
    warn(error instanceof EntryKept ? error.message : keptMessage(layout.dir, reasonOf(error)));
    return 'kept';
  } finally {
    for (const claim of [...work.instances, ...work.others, ...(work.supervisor === undefined ? [] : [work.supervisor])]) claim.held.release();
  }
};

const generationsWithMarkers = async (pass: Pass): Promise<number[]> =>
  (await namesIn(pass.files, pass.options.paths.markers.root)).map(generationOfDirectoryName).filter((generation): generation is number => generation !== undefined);

export const reapDeadGenerations = async (options: GenerationReaperOptions): Promise<GenerationReaperResult> => {
  const files = options.files ?? nodeGenerationReaperFiles;
  const pass: Pass = { options, files, sweepFiles: { readdir: files.readdir, rm: files.removeTree } };
  const removed: number[] = [];
  const kept: number[] = [];
  if (options.signal.aborted) return { removed, kept, busy: false };
  await sweepLeftovers({
    directories: [runLeftovers(options.paths)],
    lock: options.lock,
    files: pass.sweepFiles,
    warn: options.warn,
  });
  const withDirectory = new Set(await listGenerationNumbers(options.paths, files.readdir));
  const generations = [...new Set([...withDirectory, ...(await generationsWithMarkers(pass))])].sort((left, right) => left - right);
  for (const generation of generations) {
    const outcome = await reapGeneration(pass, generation, withDirectory.has(generation));
    if (outcome === 'busy') return { removed, kept, busy: true };
    if (outcome === 'interrupted') break;
    if (outcome === 'removed') removed.push(generation);
    if (outcome === 'kept') kept.push(generation);
    await sleep(systemWaitTiming, GENERATION_YIELD_MS);
  }
  return { removed, kept, busy: false };
};
