import path from 'node:path';
import type { StopValuesReader } from '@momonga/config';
import { ABANDON_KILL_GRACE_MS, GENERATION_MARKER_LABELS, GENERATION_REAPER_OCCASION, MAXIMUM_STOP_VALUES, generationLayout, momongaPaths, readStopRecord, reapDeadGenerations, reapMarkerDirectory, runtimeMaxCloseMs } from '@momonga/foundation';
import type { Clock, GenerationMarkerReap, GenerationReaperResult, JsonLogger, KernelLockMechanism, LayoutEnvironment, MarkerKind, MomongaPaths, ProcessInspector, Timing } from '@momonga/foundation';
import { DAEMON_MARKER_KILL_GRACE_MS, resolveIntervals } from './constants.ts';
import type { SupervisorTimers } from './constants.ts';
import { generationReaped, orphansWarning, writeEvent } from './log-events.ts';
import { omitUndefined } from './omit-undefined.ts';
import { reapOrphans } from './orphans.ts';
import type { MarkerPorts } from './orphans.ts';
import type { SupervisorOptions } from './start-supervisor.ts';

export type ReaperPass = NonNullable<SupervisorOptions['reaperPass']>;

export type ReaperPassOptions = {
  paths: MomongaPaths;
  lock: KernelLockMechanism;
  inspector: ProcessInspector;
  logger: JsonLogger;
  timers: SupervisorTimers;
  reapTiming: Timing;
  orphanGraceMs: number;
  orphanReapGraceMs: number;
  orphanPollMs: number;
  managedServerStopGraceMs(): number;
  markerPorts?: MarkerPorts;
  reapDeadGenerations?: typeof reapDeadGenerations;
};

type GenericMarkerKind = Exclude<MarkerKind, 'daemons'>;

const GENERIC_KILL_GRACE_MS: Readonly<Record<GenericMarkerKind, (options: ReaperPassOptions) => number>> = {
  mcp: () => ABANDON_KILL_GRACE_MS,
  tools: () => ABANDON_KILL_GRACE_MS,
  targets: (options) => options.managedServerStopGraceMs(),
};

export const createReaperPass = (options: ReaperPassOptions): ReaperPass => {
  const warned = new Set<string>();
  const warn = (detail: string): void => {
    if (warned.has(detail)) return;
    warned.add(detail);
    writeEvent(options.logger, orphansWarning({ detail }));
  };

  const reapDaemons = async ({ generation, directory, signal }: GenerationMarkerReap): Promise<void> => {
    const predecessorStopValues = await readStopRecord(generationLayout(path.dirname(options.paths.root), generation).stopRecord);
    await reapOrphans({
      markersDir: directory,
      orphanGraceMs: options.orphanGraceMs,
      orphanReapGraceMs: options.orphanReapGraceMs,
      orphanPollMs: options.orphanPollMs,
      timers: options.timers,
      signal,
      logger: options.logger,
      reapTiming: options.reapTiming,
      inspector: options.inspector,
      occasion: GENERATION_REAPER_OCCASION,
      predecessorStopValues,
      ...omitUndefined({ markerPorts: options.markerPorts }),
    });
  };

  const reapGeneric = async (kind: GenericMarkerKind, { directory, signal }: GenerationMarkerReap): Promise<void> => {
    await (options.markerPorts?.reapMarkerDirectory ?? reapMarkerDirectory)({
      dir: directory,
      killGraceMs: GENERIC_KILL_GRACE_MS[kind](options),
      label: GENERATION_MARKER_LABELS[kind],
      inspector: options.inspector,
      occasion: GENERATION_REAPER_OCCASION,
      onWarning: warn,
      signal,
      timing: options.reapTiming,
    });
  };

  let lastResult = '';
  const recordResult = (result: GenerationReaperResult): void => {
    const found = result.removed.length > 0 || result.kept.length > 0 || result.busy;
    const payload = { removed: result.removed.map(String), kept: result.kept.map(String), busy: result.busy };
    const key = found ? JSON.stringify(payload) : '';
    if (key === lastResult) return;
    lastResult = key;
    if (found) writeEvent(options.logger, generationReaped(payload));
  };

  return async ({ signal }) => {
    recordResult(
      await (options.reapDeadGenerations ?? reapDeadGenerations)({
        paths: options.paths,
        lock: options.lock,
        signal,
        warn,
        reapMarkers: (request) => (request.kind === 'daemons' ? reapDaemons(request) : reapGeneric(request.kind, request)),
      }),
    );
  };
};

export type EntryReaperValues = {
  home: string;
  env: LayoutEnvironment;
  clock: Clock;
  timers: SupervisorTimers;
  logger: JsonLogger;
  stopValues: StopValuesReader;
};

export type EntryReaperOptions = Partial<Pick<ReaperPassOptions, 'orphanGraceMs'>>;

type EntryReaperDeps = Pick<SupervisorOptions, 'intervals' | 'reapTiming' | 'lockMechanism' | 'inspector' | 'markerPorts'> & { reaper?: EntryReaperOptions };

export const entryReaperPass = (deps: EntryReaperDeps, values: EntryReaperValues): ReaperPass =>
  createReaperPass({
    paths: momongaPaths(values.home, process.platform, values.env),
    lock: deps.lockMechanism,
    inspector: deps.inspector,
    logger: values.logger,
    timers: values.timers,
    reapTiming: deps.reapTiming ?? { now: () => values.clock.now(), monotonicMs: () => values.clock.now(), setTimeout: (callback, ms) => values.timers.setTimeout(callback, ms), clearTimeout: (handle) => values.timers.clearTimeout(handle) },
    orphanGraceMs: deps.reaper?.orphanGraceMs ?? runtimeMaxCloseMs(MAXIMUM_STOP_VALUES),
    orphanReapGraceMs: DAEMON_MARKER_KILL_GRACE_MS,
    orphanPollMs: resolveIntervals(deps.intervals).orphanPollMs,
    managedServerStopGraceMs: () => values.stopValues.read().managedServerStopGraceMs,
    ...omitUndefined({ markerPorts: deps.markerPorts }),
  });
