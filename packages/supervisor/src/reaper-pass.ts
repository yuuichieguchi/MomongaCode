import path from 'node:path';
import type { StopValuesReader } from '@momonga/config';
import { GENERATION_MARKER_LABELS, GENERATION_REAPER_OCCASION, generationLayout, momongaPaths, readStopRecord, reapDeadGenerations, reapMarkerDirectory } from '@momonga/foundation';
import type { Clock, GenerationMarkerReap, JsonLogger, KernelLockMechanism, MarkerKind, MomongaPaths, Timing, ProcessInspector, LayoutEnvironment } from '@momonga/foundation';
import { DAEMON_MARKER_KILL_GRACE_MS } from './constants.ts';
import type { SupervisorTimers } from './constants.ts';
import { orphansWarning, writeEvent } from './log-events.ts';
import { omitUndefined } from './omit-undefined.ts';
import { reapOrphans } from './orphans.ts';
import type { MarkerPorts } from './orphans.ts';
import { resolveStartTiming } from './start-supervisor.ts';
import type { SupervisorOptions } from './start-supervisor.ts';

export const DEAD_GENERATION_MARKER_KILL_GRACE_MS = 2000;

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
  mcp: () => DEAD_GENERATION_MARKER_KILL_GRACE_MS,
  tools: () => DEAD_GENERATION_MARKER_KILL_GRACE_MS,
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

  return async ({ signal }) => {
    await (options.reapDeadGenerations ?? reapDeadGenerations)({
      paths: options.paths,
      lock: options.lock,
      signal,
      warn,
      reapMarkers: (request) => (request.kind === 'daemons' ? reapDaemons(request) : reapGeneric(request.kind, request)),
    });
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

type EntryReaperDeps = Pick<SupervisorOptions, 'startupTimeoutMs' | 'orphanGraceMs' | 'intervals' | 'reapTiming' | 'lockMechanism' | 'inspector' | 'markerPorts'>;

export const entryReaperPass = (deps: EntryReaperDeps, values: EntryReaperValues): ReaperPass => {
  const timing = resolveStartTiming(deps);
  return createReaperPass({
    paths: momongaPaths(values.home, process.platform, values.env),
    lock: deps.lockMechanism,
    inspector: deps.inspector,
    logger: values.logger,
    timers: values.timers,
    reapTiming: deps.reapTiming ?? { now: () => values.clock.now(), monotonicMs: () => values.clock.now(), setTimeout: (callback, ms) => values.timers.setTimeout(callback, ms), clearTimeout: (handle) => values.timers.clearTimeout(handle) },
    orphanGraceMs: timing.orphanGraceMs,
    orphanReapGraceMs: DAEMON_MARKER_KILL_GRACE_MS,
    orphanPollMs: timing.orphanPollMs,
    managedServerStopGraceMs: () => values.stopValues.read().managedServerStopGraceMs,
    ...omitUndefined({ markerPorts: deps.markerPorts }),
  });
};
