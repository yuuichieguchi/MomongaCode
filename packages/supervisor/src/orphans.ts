import fs from 'node:fs';
import path from 'node:path';
import { RUNTIME_DEFAULT_DRAIN_TIMEOUT_MS, findHolders, isTransientFailure, reapMarkedProcesses, reapMarkerDirectory, runtimeMaxCloseMs, uuidv7 } from '@momonga/foundation';
import type { JsonLogger, ReapTiming } from '@momonga/foundation';
import { DAEMON_MARKER_KILL_GRACE_MS } from './constants.ts';
import type { SupervisorTimers } from './constants.ts';
import type { ChildRole } from './launcher.ts';
import { orphansReaping, orphansWaiting, orphansWarning, writeEvent } from './log-events.ts';
import { omitUndefined } from './omit-undefined.ts';

export type MarkerFiles = {
  createExclusive(markerPath: string, mode: number): void;
  openReadOnly(markerPath: string): number;
  closeDescriptor(descriptor: number): void;
  remove(markerPath: string): void;
};

export const nodeMarkerFiles: MarkerFiles = {
  createExclusive: (markerPath, mode) => fs.closeSync(fs.openSync(markerPath, 'wx', mode)),
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
  drainTimeoutMs?: number;
  timers: SupervisorTimers;
  signal: AbortSignal;
  logger: JsonLogger;
  reapTiming: ReapTiming;
  markerPorts?: MarkerPorts;
};

export type OrphanReapResult = { reaped: number; kept: number; aborted: boolean };

const MARKER_MODE = 0o600;

export const openDaemonMarker = (directory: string, role: ChildRole, files: MarkerFiles = nodeMarkerFiles): DaemonMarker => {
  const markerPath = path.join(directory, `${role}-${uuidv7()}`);
  files.createExclusive(markerPath, MARKER_MODE);
  let fd: number;
  try {
    fd = files.openReadOnly(markerPath);
  } catch (error) {
    files.remove(markerPath);
    throw error;
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

export const reapDaemonMarker = async (input: { marker: string; logger: JsonLogger; markerPorts?: MarkerPorts }): Promise<{ removed: boolean }> => {
  const reap = input.markerPorts?.reapMarkedProcesses ?? reapMarkedProcesses;
  try {
    return await reap({
      marker: input.marker,
      killGraceMs: DAEMON_MARKER_KILL_GRACE_MS,
      label: 'daemon',
      onWarning: (detail) => writeEvent(input.logger, orphansWarning({ detail, marker: input.marker })),
    });
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    writeEvent(input.logger, orphansWarning({ detail: failure.message, marker: input.marker }, failure));
    return { removed: false };
  }
};

const listMarkerNames = (markersDir: string): Promise<string[]> => fs.promises.readdir(markersDir);

const PHASE_ONE_MARGIN_MS = 2000;

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

export const reapOrphans = async (options: OrphanReapOptions): Promise<OrphanReapResult> => {
  const { signal, logger } = options;
  const holdersOf = options.markerPorts?.findHolders ?? findHolders;
  const reapDirectory = options.markerPorts?.reapMarkerDirectory ?? reapMarkerDirectory;
  const { now } = options.reapTiming;
  const listNames = options.markerPorts?.listMarkers ?? listMarkerNames;
  const warn = (detail: string): void => writeEvent(logger, orphansWarning({ detail }));

  const countHolders = async (markers: readonly string[]): Promise<number> => {
    const lists = await Promise.all(markers.map((marker) => holdersOf(marker)));
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

  const markers = await listMarkers();

  if (signal.aborted) return { reaped: 0, kept: 0, aborted: true };

  if (markers.length === 0) {
    writeEvent(logger, orphansWaiting({ markers: 0, holders: 0 }));
    return { reaped: 0, kept: 0, aborted: false };
  }
  const graceMs = Math.min(options.orphanGraceMs, runtimeMaxCloseMs(options.drainTimeoutMs ?? RUNTIME_DEFAULT_DRAIN_TIMEOUT_MS) + PHASE_ONE_MARGIN_MS);
  const deadline = now() + graceMs;

  const observe = async (): Promise<number | undefined> => {
    try {
      return await countHolders(markers);
    } catch (error) {
      if (isTransientFailure(error) && now() < deadline) {
        warn(`daemon marker holders could not be listed yet: ${failureOf(error).message}`);
        return undefined;
      }
      throw error;
    }
  };

  let holders = await observe();
  if (holders !== undefined) writeEvent(logger, orphansWaiting({ markers: markers.length, holders }));
  while (holders === undefined || holders > 0) {
    await sleepUnlessAborted(options, options.orphanPollMs);
    if (signal.aborted) return { reaped: 0, kept: 0, aborted: true };
    holders = await observe();
    if (signal.aborted) return { reaped: 0, kept: 0, aborted: true };
    if (holders !== undefined && holders > 0 && now() >= deadline) break;
  }

  writeEvent(logger, orphansReaping({ holders }));
  const result = await reapDirectory({
    dir: options.markersDir,
    killGraceMs: options.orphanReapGraceMs,
    label: 'daemon',
    onWarning: warn,
    signal,
    timing: options.reapTiming,
  });
  return { reaped: result.reaped, kept: result.kept, aborted: signal.aborted };
};
