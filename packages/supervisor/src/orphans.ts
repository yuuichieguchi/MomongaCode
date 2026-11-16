import fs from 'node:fs';
import path from 'node:path';
import { MAXIMUM_STOP_VALUES, findHolders, isTransientFailure, markerReapClockBoundMs, readAttemptRecord, reapMarkedProcesses, reapMarkerDirectory, reportUninspectableOnce, runtimeMaxCloseMs, uuidv7 } from '@momonga/foundation';
import type { JsonLogger, Timing, RetryKind, StopValues, UninspectableRegistry, ProcessGroupPort, ProcessInspector } from '@momonga/foundation';
import { DAEMON_MARKER_KILL_GRACE_MS } from './constants.ts';
import type { SupervisorTimers } from './constants.ts';
import type { ChildRole } from './launcher.ts';
import { orphansReaping, orphansWaiting, orphansWarning, writeEvent } from './log-events.ts';
import { omitUndefined } from './omit-undefined.ts';

export type MarkerFiles = {
  createExclusive(markerPath: string, mode: number): number;
  openReadOnly(markerPath: string): number;
  closeDescriptor(descriptor: number): void;
  remove(markerPath: string): void;
};

export const nodeMarkerFiles: MarkerFiles = {
  createExclusive: (markerPath, mode) => fs.openSync(markerPath, 'wx', mode),
  openReadOnly: (markerPath) => fs.openSync(markerPath, 'r'),
  closeDescriptor: (descriptor) => fs.closeSync(descriptor),
  remove: (markerPath) => fs.rmSync(markerPath, { force: true }),
};

export type MarkerPorts = {
  files?: MarkerFiles;
  findHolders?: typeof findHolders;
  reapMarkerDirectory?: typeof reapMarkerDirectory;
  reapMarkedProcesses?: typeof reapMarkedProcesses;
  listMarkers?: (markersDir: string) => Promise<string[]>;
  groupPort?: ProcessGroupPort;
};

export type DaemonMarker = {
  readonly path: string;
  readonly fd: number;
  closeFd(): void;
  remove(): void;
};

export type OrphanReapOptions = {
  markersDir: string;
  orphanGraceMs: number;
  orphanReapGraceMs: number;
  orphanPollMs: number;
  predecessorStopValues?: StopValues | undefined;
  timers: SupervisorTimers;
  signal: AbortSignal;
  logger: JsonLogger;
  reapTiming: Timing;
  inspector: ProcessInspector;
  markerPorts?: MarkerPorts;
  uninspectable?: UninspectableRegistry;
  occasion?: RetryKind;
};

export type OrphanReapResult = { reaped: number; kept: number; aborted: boolean };

const MARKER_MODE = 0o600;

export const openDaemonMarker = (directory: string, role: ChildRole, files: MarkerFiles = nodeMarkerFiles): DaemonMarker => {
  const markerPath = path.join(directory, `${role}-${uuidv7()}`);
  const creator = files.createExclusive(markerPath, MARKER_MODE);
  let fd: number;
  try {
    fd = files.openReadOnly(markerPath);
  } catch (error) {
    files.remove(markerPath);
    throw error;
  } finally {
    files.closeDescriptor(creator);
  }
  let open = true;
  return {
    path: markerPath,
    fd,
    closeFd: () => {
      if (!open) return;
      open = false;
      files.closeDescriptor(fd);
    },
    remove: () => {
      files.remove(markerPath);
    },
  };
};

export const reapDaemonMarker = async (input: { marker: string; logger: JsonLogger; inspector: ProcessInspector; signal?: AbortSignal; markerPorts?: MarkerPorts }): Promise<{ removed: boolean }> => {
  const reap = input.markerPorts?.reapMarkedProcesses ?? reapMarkedProcesses;
  try {
    return await reap({
      marker: input.marker,
      killGraceMs: DAEMON_MARKER_KILL_GRACE_MS,
      label: 'daemon',
      onWarning: (detail) => writeEvent(input.logger, orphansWarning({ detail, marker: input.marker })),
      inspector: input.inspector,
      ...(input.markerPorts?.groupPort === undefined ? {} : { groupPort: input.markerPorts.groupPort }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    writeEvent(input.logger, orphansWarning({ detail: failure.message, marker: input.marker }, failure));
    return { removed: false };
  }
};

const listMarkerNames = (markersDir: string): Promise<string[]> => fs.promises.readdir(markersDir);

type Observation = { kind: 'listed'; holders: number } | { kind: 'unlisted'; error: Error } | { kind: 'deadline' } | { kind: 'aborted' };

type OrphanReapTiming = Pick<OrphanReapOptions, 'orphanGraceMs' | 'orphanReapGraceMs' | 'orphanPollMs' | 'predecessorStopValues'>;

const phaseOneGraceMs = (timing: Pick<OrphanReapTiming, 'orphanGraceMs' | 'predecessorStopValues'>): number =>
  Math.min(timing.orphanGraceMs, runtimeMaxCloseMs(timing.predecessorStopValues ?? MAXIMUM_STOP_VALUES));

export const orphanPhaseOneBoundMs = (timing: Pick<OrphanReapTiming, 'orphanGraceMs' | 'orphanPollMs' | 'predecessorStopValues'>): number => phaseOneGraceMs(timing) + timing.orphanPollMs;

export const orphanReapBoundMs = (timing: OrphanReapTiming): number => orphanPhaseOneBoundMs(timing) + markerReapClockBoundMs(timing.orphanReapGraceMs);

const failureOf = (error: unknown): Error => (error instanceof Error ? error : new Error(String(error)));

const sleepUnlessAborted = (options: OrphanReapOptions, ms: number): Promise<void> =>
  new Promise<void>((resolve) => {
    if (options.signal.aborted) {
      resolve();
      return;
    }
    const finish = (): void => {
      options.timers.clearTimeout(handle);
      options.signal.removeEventListener('abort', finish);
      resolve();
    };
    const handle = options.timers.setTimeout(finish, ms);
    options.signal.addEventListener('abort', finish, { once: true });
  });

const hasChanceLeft = async (marker: string, occasion: RetryKind): Promise<boolean> => {
  try {
    const record = await readAttemptRecord(marker);
    return !record.ignored && !record.spent[occasion];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
};

const markersWithChanceLeft = async (markers: readonly string[], occasion: RetryKind | undefined): Promise<string[]> => {
  if (occasion === undefined) return [...markers];
  const left: string[] = [];
  for (const marker of markers) if (await hasChanceLeft(marker, occasion)) left.push(marker);
  return left;
};

export const reapOrphans = async (options: OrphanReapOptions): Promise<OrphanReapResult> => {
  const { signal, logger } = options;
  const holdersOf = options.markerPorts?.findHolders ?? findHolders;
  const reapDirectory = options.markerPorts?.reapMarkerDirectory ?? reapMarkerDirectory;
  const { now } = options.reapTiming;
  const listNames = options.markerPorts?.listMarkers ?? listMarkerNames;
  const warn = (detail: string): void => writeEvent(logger, orphansWarning({ detail }));

  const countHolders = async (markers: readonly string[], probeSignal: AbortSignal): Promise<number> => {
    const lists = await Promise.all(markers.map((marker) => holdersOf(marker, { signal: probeSignal, inspector: options.inspector, onUninspectable: reportUninspectableOnce(warn, `marker ${marker}`, options.uninspectable) })));
    return lists.reduce((total, list) => total + list.length, 0);
  };

  const listMarkers = async (): Promise<string[]> => {
    try {
      return (await listNames(options.markersDir)).map((name) => path.join(options.markersDir, name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  };

  const listed = await listMarkers();
  const markers = await markersWithChanceLeft(listed, options.occasion);

  if (signal.aborted) return { reaped: 0, kept: 0, aborted: true };

  if (listed.length === 0) {
    writeEvent(logger, orphansWaiting({ markers: 0, holders: 0 }));
    return { reaped: 0, kept: 0, aborted: false };
  }
  if (markers.length === 0) return { reaped: 0, kept: listed.length, aborted: false };
  const graceMs = phaseOneGraceMs(options);
  const deadline = now() + graceMs;
  const phaseStop = new AbortController();
  const phaseEnded = new Promise<Observation>((resolve) => phaseStop.signal.addEventListener('abort', () => resolve({ kind: 'deadline' }), { once: true }));
  const phaseTimer = options.timers.setTimeout(() => phaseStop.abort(new Error(`the orphan phase deadline of ${graceMs} ms passed`)), graceMs);
  const probeSignal = AbortSignal.any([signal, phaseStop.signal]);

  const listing = async (): Promise<Observation> => {
    try {
      return { kind: 'listed', holders: await countHolders(markers, probeSignal) };
    } catch (error) {
      if (signal.aborted) return { kind: 'aborted' };
      if (phaseStop.signal.aborted) return { kind: 'deadline' };
      if (isTransientFailure(error) && now() < deadline) return { kind: 'unlisted', error: failureOf(error) };
      throw error;
    }
  };

  const observe = (): Promise<Observation> => (phaseStop.signal.aborted ? phaseEnded : Promise.race([listing(), phaseEnded]));

  let holders: number | undefined;
  let unlisted: Error | undefined;
  try {
    for (let first = true; ; first = false) {
      if (!first) await sleepUnlessAborted(options, options.orphanPollMs);
      if (signal.aborted) return { reaped: 0, kept: 0, aborted: true };
      const seen = await observe();
      if (signal.aborted || seen.kind === 'aborted') return { reaped: 0, kept: 0, aborted: true };
      if (seen.kind === 'deadline') {
        if (holders !== undefined) break;
        throw unlisted ?? new Error(`no listing of the daemon marker holders finished within the orphan phase deadline of ${graceMs} ms`);
      }
      if (seen.kind === 'unlisted') {
        unlisted = seen.error;
        holders = undefined;
        warn(`daemon marker holders could not be listed yet: ${seen.error.message}`);
        continue;
      }
      if (first) writeEvent(logger, orphansWaiting({ markers: markers.length, holders: seen.holders }));
      unlisted = undefined;
      holders = seen.holders;
      if (holders === 0 || now() >= deadline) break;
    }
  } finally {
    options.timers.clearTimeout(phaseTimer);
  }

  writeEvent(logger, orphansReaping({ holders }));
  const result = await reapDirectory({
    dir: options.markersDir,
    killGraceMs: options.orphanReapGraceMs,
    label: 'daemon',
    onWarning: warn,
    signal,
    timing: options.reapTiming,
    inspector: options.inspector,
    ...(options.markerPorts?.groupPort === undefined ? {} : { groupPort: options.markerPorts.groupPort }),
    ...(options.occasion === undefined ? {} : { occasion: options.occasion }),
  });
  return { reaped: result.reaped, kept: result.kept, aborted: signal.aborted };
};
