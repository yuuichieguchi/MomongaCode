import path from 'node:path';
import { writeFileAtomically } from './atomic-file.ts';
import type { AtomicWriteFileSystem } from './atomic-file.ts';
import { CurrentGenerationMalformedError, readCurrentGeneration } from './current-generation.ts';
import type { CurrentGeneration } from './current-generation.ts';
import { START_RECORD_MODE, formatStartRecord, listGenerations, readStartRecord } from './generation-registry.ts';
import type { ListedGeneration, LockProbeOptions } from './generation-registry.ts';
import { createGenerationDirs, generationLayout, refuseUnfitGenerationSocketsBeforeCreation } from './momonga-paths.ts';
import type { MomongaPaths } from './momonga-paths.ts';
import { nodeFileSystem, readFileHead } from './node-file-system.ts';
import type { KernelLockMechanism } from './platform/kernel-lock.ts';
import { claimNewEntry, lockFormOf } from './platform/lock-form.ts';
import { ProcessLockHeldError, acquireProcessLock } from './process-lock.ts';
import type { ProcessLock } from './process-lock.ts';
import { systemRandom } from './system-random.ts';
import { isAtLeastVersion, orderVersions } from './version-order.ts';

export type StartTrigger = 'client' | 'restart' | 'childMismatch';

export type GenerationRef = { generation: number; version: string };

export type StartView = {
  trigger?: StartTrigger;
  clientVersion: string;
  current?: GenerationRef;
  serving: boolean;
  starting: readonly GenerationRef[];
};

export type StartDecision =
  | { kind: 'connect'; generation: number }
  | { kind: 'older'; version: string }
  | { kind: 'below-floor'; floor: string }
  | { kind: 'join'; generation: number }
  | { kind: 'allocate' };

const joinOrAllocate = (version: string, starting: readonly GenerationRef[]): StartDecision => {
  const joinable = starting.filter((candidate) => isAtLeastVersion(candidate.version, version));
  const newest = joinable.reduce<GenerationRef | undefined>((best, candidate) => (best === undefined || candidate.generation > best.generation ? candidate : best), undefined);
  return newest === undefined ? { kind: 'allocate' } : { kind: 'join', generation: newest.generation };
};

const decideForClient = (view: StartView): StartDecision => {
  const { current, clientVersion } = view;
  if (current !== undefined) {
    const order = orderVersions(clientVersion, current.version);
    if (view.serving && order === 'same') return { kind: 'connect', generation: current.generation };
    if (view.serving && order !== 'newer') return { kind: 'older', version: current.version };
    if (!view.serving && order !== 'same' && order !== 'newer') return { kind: 'below-floor', floor: current.version };
  }
  return joinOrAllocate(clientVersion, view.starting);
};

const decideForChildMismatch = (view: StartView): StartDecision => {
  const { current, clientVersion } = view;
  if (current === undefined) return joinOrAllocate(clientVersion, view.starting);
  const order = orderVersions(clientVersion, current.version);
  if (order === 'same') return { kind: 'connect', generation: current.generation };
  if (order !== 'newer') return { kind: 'below-floor', floor: current.version };
  return joinOrAllocate(clientVersion, view.starting);
};

export const decideGenerationStart = (view: StartView): StartDecision => {
  switch (view.trigger ?? 'client') {
    case 'client':
      return decideForClient(view);
    case 'restart':
      return { kind: 'allocate' };
    case 'childMismatch':
      return decideForChildMismatch(view);
  }
};

export const GENERATION_COUNTER_READ_BYTES = 17;

const GENERATION_COUNTER_MODE = 0o600;

const SAFE_INTEGER_DIGITS = String(Number.MAX_SAFE_INTEGER).length;

export type GenerationCounterReason = 'it is not a regular file' | 'it does not hold one decimal number' | 'it is larger than a safe integer';

export class GenerationCounterError extends Error {
  readonly code = 'generation_counter';
  readonly path: string;
  readonly reason: GenerationCounterReason;

  constructor(file: string, reason: GenerationCounterReason) {
    super(
      `momonga cannot read the generation counter at ${file}: ${reason}. No generation was started, because a generation number is never guessed. Repair the file so that it holds one decimal number, then run the command again.`,
    );
    this.name = 'GenerationCounterError';
    this.path = file;
    this.reason = reason;
  }
}

export class GenerationPrepareError extends Error {
  readonly generation: number;

  constructor(generation: number, cause: unknown) {
    const code = typeof cause === 'object' && cause !== null && 'code' in cause && typeof cause.code === 'string' ? `${cause.code} ` : '';
    super(`could not prepare generation ${generation}: ${code}${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = 'GenerationPrepareError';
    this.generation = generation;
  }
}

export class CurrentGenerationUnreadableError extends Error {
  readonly path: string;

  constructor(file: string, cause: unknown) {
    const reason = cause instanceof CurrentGenerationMalformedError ? cause.reason : cause instanceof Error ? cause.message : String(cause);
    super(`momonga cannot read ${file}: ${reason}. No generation was started. Repair or remove the file, then run the command again.`, { cause });
    this.name = 'CurrentGenerationUnreadableError';
    this.path = file;
  }
}

export type GenerationStartFiles = {
  readonly atomic: AtomicWriteFileSystem;
  isRegularFile(file: string): Promise<boolean | undefined>;
  readHead(file: string, maxBytes: number): Promise<Uint8Array>;
  readdir(directory: string): Promise<string[]>;
  createGenerationDirs(paths: MomongaPaths, generation: number): Promise<void>;
};

const missing = (error: unknown): boolean => typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';

export const nodeGenerationStartFiles: GenerationStartFiles = {
  atomic: nodeFileSystem,
  isRegularFile: async (file) => {
    try {
      return (await nodeFileSystem.lstat(file)).isFile();
    } catch (error) {
      if (missing(error)) return undefined;
      throw error;
    }
  },
  readHead: readFileHead,
  readdir: (directory) => nodeFileSystem.readdir(directory),
  createGenerationDirs: (paths, generation) => createGenerationDirs(paths, generation),
};

const DECIMAL_NUMBER = /^[1-9][0-9]*$/;

export const parseGenerationCounter = (file: string, head: Uint8Array): number => {
  const text = Buffer.from(head).toString('latin1');
  const digits = text.endsWith('\n') ? text.slice(0, -1) : text;
  if (!DECIMAL_NUMBER.test(digits)) throw new GenerationCounterError(file, 'it does not hold one decimal number');
  if (digits.length > SAFE_INTEGER_DIGITS || !Number.isSafeInteger(Number(digits))) throw new GenerationCounterError(file, 'it is larger than a safe integer');
  return Number(digits);
};

export const readGenerationCounter = async (paths: MomongaPaths, files: GenerationStartFiles = nodeGenerationStartFiles): Promise<number | undefined> => {
  const regular = await files.isRegularFile(paths.generationCounter);
  if (regular === undefined) return undefined;
  if (!regular) throw new GenerationCounterError(paths.generationCounter, 'it is not a regular file');
  return parseGenerationCounter(paths.generationCounter, await files.readHead(paths.generationCounter, GENERATION_COUNTER_READ_BYTES));
};

export type HeldStart = { release(): void };

export type StartOutcome =
  | { kind: 'allocated'; generation: number; starting: HeldStart }
  | { kind: 'joined'; generation: number }
  | { kind: 'serving'; generation: number; version: string }
  | { kind: 'older'; version: string }
  | { kind: 'below-floor'; floor: string }
  | { kind: 'busy' };

export type BeginGenerationStartOptions = {
  version: string;
  foldVersion: number;
  lock: KernelLockMechanism;
  trigger?: StartTrigger;
  draining?: number;
  files?: GenerationStartFiles;
  onProbeFailure?: LockProbeOptions['onProbeFailure'];
};

const homeOf = (paths: MomongaPaths): string => path.dirname(paths.root);

const readCurrentForStart = async (paths: MomongaPaths): Promise<CurrentGeneration | undefined> => {
  try {
    return await readCurrentGeneration(paths);
  } catch (error) {
    throw new CurrentGenerationUnreadableError(paths.current, error);
  }
};

const startingOf = (listed: readonly ListedGeneration[], current: CurrentGeneration | undefined): GenerationRef[] =>
  listed.flatMap((entry) =>
    entry.live && entry.record.kind === 'record' && entry.generation > (current?.generation ?? 0) ? [{ generation: entry.generation, version: entry.record.record.version }] : [],
  );

const floorOf = (listed: readonly ListedGeneration[], current: CurrentGeneration | undefined): number =>
  listed.reduce((highest, entry) => Math.max(highest, entry.generation), current?.generation ?? 0);

const allocate = async (
  paths: MomongaPaths,
  options: BeginGenerationStartOptions,
  files: GenerationStartFiles,
  floor: number,
): Promise<Extract<StartOutcome, { kind: 'allocated' }>> => {
  const generation = ((await readGenerationCounter(paths, files)) ?? floor) + 1;
  if (!Number.isSafeInteger(generation)) throw new GenerationCounterError(paths.generationCounter, 'it is larger than a safe integer');
  await refuseUnfitGenerationSocketsBeforeCreation(paths, generation);
  try {
    await writeFileAtomically(files.atomic, systemRandom, paths.generationCounter, `${generation}\n`, { mode: GENERATION_COUNTER_MODE, lock: options.lock });
    await files.createGenerationDirs(paths, generation);
    const layout = generationLayout(homeOf(paths), generation);
    await writeFileAtomically(files.atomic, systemRandom, layout.startRecord, formatStartRecord({ version: options.version, foldVersion: options.foldVersion }), {
      mode: START_RECORD_MODE,
      lock: options.lock,
    });
    const held = await claimNewEntry(options.lock, layout.startingLock, lockFormOf(options.lock, 'file'));
    return { kind: 'allocated', generation, starting: { release: () => held.release() } };
  } catch (error) {
    throw new GenerationPrepareError(generation, error);
  }
};

export const beginGenerationStart = async (paths: MomongaPaths, options: BeginGenerationStartOptions): Promise<StartOutcome> => {
  const files = options.files ?? nodeGenerationStartFiles;
  const claim = await options.lock.claim(paths.generationLock);
  if (claim.kind === 'held') return { kind: 'busy' };
  try {
    const current = await readCurrentForStart(paths);
    const listed = await listGenerations(paths, { lock: options.lock, readdir: files.readdir, ...(options.onProbeFailure === undefined ? {} : { onProbeFailure: options.onProbeFailure }) });
    const currentEntry = current === undefined ? undefined : listed.find((entry) => entry.generation === current.generation);
    const serving = current !== undefined && currentEntry?.supervisorHeld === true && options.draining !== current.generation;
    const decision = decideGenerationStart({
      trigger: options.trigger ?? 'client',
      clientVersion: options.version,
      ...(current === undefined ? {} : { current: { generation: current.generation, version: current.version } }),
      serving,
      starting: startingOf(listed, current),
    });
    switch (decision.kind) {
      case 'connect':
        return { kind: 'serving', generation: decision.generation, version: current?.version ?? options.version };
      case 'older':
        return { kind: 'older', version: decision.version };
      case 'below-floor':
        return { kind: 'below-floor', floor: decision.floor };
      case 'join':
        return { kind: 'joined', generation: decision.generation };
      case 'allocate':
        return await allocate(paths, options, files, floorOf(listed, current));
    }
  } finally {
    claim.lock.release();
  }
};

export const ABANDON_REASONS = ['directory-missing', 'record-missing', 'record-unreadable', 'version-differs', 'lock-held'] as const;

export type AbandonReason = (typeof ABANDON_REASONS)[number];

export const START_FAILURE_REASONS = [...ABANDON_REASONS, 'stopped-before-ready', 'exited-before-ready', 'launch-failed', 'older-started-first'] as const;

export type StartFailureReason = (typeof START_FAILURE_REASONS)[number];

export type GenerationClaim = { kind: 'claimed'; lock: ProcessLock } | { kind: 'abandoned'; reason: AbandonReason } | { kind: 'busy' };

export type ClaimGenerationOptions = {
  version: string;
  lock: KernelLockMechanism;
  acquire?: (lockPath: string) => Promise<ProcessLock>;
};

const directoryPresent = async (directory: string): Promise<boolean> => {
  try {
    return (await nodeFileSystem.lstat(directory)).isDirectory();
  } catch (error) {
    if (missing(error)) return false;
    throw error;
  }
};

export const claimGeneration = async (paths: MomongaPaths, generation: number, options: ClaimGenerationOptions): Promise<GenerationClaim> => {
  const layout = generationLayout(homeOf(paths), generation);
  const claim = await options.lock.claim(paths.generationLock);
  if (claim.kind === 'held') return { kind: 'busy' };
  try {
    if (!(await directoryPresent(layout.dir))) return { kind: 'abandoned', reason: 'directory-missing' };
    const record = await readStartRecord(paths, generation);
    if (record.kind === 'missing') return { kind: 'abandoned', reason: 'record-missing' };
    if (record.kind === 'unreadable') return { kind: 'abandoned', reason: 'record-unreadable' };
    if (record.record.version !== options.version) return { kind: 'abandoned', reason: 'version-differs' };
    const acquire = options.acquire ?? ((lockPath: string) => acquireProcessLock(lockPath, undefined, { mechanism: options.lock }));
    try {
      return { kind: 'claimed', lock: await acquire(layout.locks.supervisor) };
    } catch (error) {
      if (error instanceof ProcessLockHeldError) return { kind: 'abandoned', reason: 'lock-held' };
      throw error;
    }
  } finally {
    claim.lock.release();
  }
};

export type StarterView = {
  own: GenerationRef;
  current?: GenerationRef;
  currentHeld: boolean;
  currentDraining: boolean;
  ownSupervisorGone: boolean;
  ownDirectoryGone?: boolean;
};

export type StarterOutcome = 'success' | 'waiting' | 'failed';

export const starterOutcome = (view: StarterView): StarterOutcome => {
  const { own, current } = view;
  const covered = current !== undefined && current.generation >= own.generation && isAtLeastVersion(current.version, own.version);
  if (covered && view.currentHeld && !view.currentDraining) return 'success';
  if (view.ownDirectoryGone === true || view.ownSupervisorGone) return 'failed';
  return 'waiting';
};
