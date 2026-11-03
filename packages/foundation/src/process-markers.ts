import fs from 'node:fs';
import path from 'node:path';
import { isProcessAlive } from './process-alive.ts';
import type { SignalSender } from './process-alive.ts';
import { hostSignalSender } from './platform/group-port.ts';
import { ProbeFailedError, valueOrThrow } from './platform/inspector-types.ts';
import { noFollowFlag } from './platform/privacy.ts';
import { REAP_POLL_INTERVAL_MS, hostProbeTiming } from './platform/probe-timing.ts';
import type { ProbeTiming } from './platform/probe-timing.ts';
import type { ProcessInspector, UninspectableProcess } from './platform/inspector-types.ts';
import { defaultProcessInspector } from './platform/process-inspector.ts';

export type ReapTiming = ProbeTiming;

export const hostReapTiming: ReapTiming = hostProbeTiming;

export { REAP_POLL_INTERVAL_MS };

const defaultKill: SignalSender = hostSignalSender;

const isAborted = (signal: AbortSignal | undefined): boolean => signal?.aborted === true;

const graceSleep = async (timing: ReapTiming, ms: number, signal: AbortSignal | undefined): Promise<void> => {
  if (signal === undefined) {
    await timing.sleep(ms);
    return;
  }
  const deadline = timing.now() + ms;
  while (!signal.aborted) {
    const remaining = deadline - timing.now();
    if (remaining <= 0) return;
    await timing.sleep(Math.min(REAP_POLL_INTERVAL_MS, remaining));
  }
};

export const findHolders = async (marker: string, inspector: ProcessInspector = defaultProcessInspector()): Promise<number[]> =>
  valueOrThrow(`listing the holders of ${marker}`, await inspector.holdersOf(marker), []).filter((pid) => pid !== process.pid);

const groupsByHolder = async (holders: readonly number[], candidateGroups: readonly number[], inspector: ProcessInspector): Promise<Map<number, number>> =>
  valueOrThrow(`reading the process groups of ${holders.join(',')}`, await inspector.groupsOf(holders, candidateGroups), new Map<number, number>());

const holdersUntil = async (
  marker: string,
  inspector: ProcessInspector,
  timing: ReapTiming,
  deadline: number,
  signal: AbortSignal | undefined,
): Promise<number[]> => {
  for (;;) {
    try {
      return await findHolders(marker, inspector);
    } catch (error) {
      const retryable = error instanceof ProbeFailedError && error.probeCause === 'transient' && timing.now() < deadline && !isAborted(signal);
      if (!retryable) throw error;
      await timing.sleep(REAP_POLL_INTERVAL_MS);
    }
  }
};

export const holderGroups = async (
  holders: readonly number[],
  candidateGroups: readonly number[] = [],
  inspector: ProcessInspector = defaultProcessInspector(),
): Promise<number[]> => [...(await groupsByHolder(holders, candidateGroups, inspector)).values()];

const signalTargets = (send: SignalSender, targets: readonly number[], signal: NodeJS.Signals): number[] => {
  const unsignalled: number[] = [];
  for (const target of targets) {
    try {
      send(target, signal);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EPERM') unsignalled.push(Math.abs(target));
      else if (code !== 'ESRCH') throw error;
    }
  }
  return unsignalled;
};

export type MarkerReconcileResult = {
  outcome: 'unknown';
  output: string;
  stopped: boolean;
  leftAloneGroup?: number;
  leftAlonePids: number[];
  unsignalledPids: number[];
};

type StructuredFindings = { leftAloneGroup?: number; leftAlonePids?: number[]; unsignalledPids?: number[] };

const unknownResult = (detail: string, stopped: boolean, { leftAloneGroup, leftAlonePids = [], unsignalledPids = [] }: StructuredFindings = {}): MarkerReconcileResult => ({
  outcome: 'unknown',
  output: `${detail} The effect of the interrupted command is unknown; inspect the current state before retrying it.`,
  stopped,
  ...(leftAloneGroup === undefined ? {} : { leftAloneGroup }),
  leftAlonePids,
  unsignalledPids,
});

export const stoppedCommandResult = (): MarkerReconcileResult => unknownResult('The interrupted command was stopped.', true);

export const reconcileProcessGroup = async (
  recorded: { pgid: number; marker: string },
  {
    killGraceMs = 2000,
    kill = defaultKill,
    timing = hostReapTiming,
    signal,
    inspector = defaultProcessInspector(),
  }: { killGraceMs?: number; kill?: SignalSender; timing?: ReapTiming; signal?: AbortSignal; inspector?: ProcessInspector } = {},
): Promise<MarkerReconcileResult> => {
  const { pgid, marker } = recorded;
  const holders = await holdersUntil(marker, inspector, timing, timing.now() + killGraceMs, signal);
  const groupAlive = isProcessAlive(-pgid, kill);
  if (!groupAlive && holders.length === 0) return unknownResult('The interrupted command is no longer running.', false);
  if (holders.length === 0) {
    return unknownResult(
      `Processes in group ${pgid} are still running but could not be verified as belonging to this call (for example they closed the inherited descriptor), so they were left alone.`,
      false,
      { leftAloneGroup: pgid },
    );
  }
  const holderGroup = groupAlive ? await groupsByHolder(holders, [pgid], inspector) : new Map<number, number>();
  const groupVerified = [...holderGroup.values()].includes(pgid);
  const holdersOutsideGroup = groupVerified ? holders.filter((pid) => holderGroup.get(pid) !== pgid) : holders;
  const termTargets = [...(groupVerified ? [-pgid] : []), ...holdersOutsideGroup];
  const unsignalled = new Set(signalTargets(kill, termTargets, 'SIGTERM'));
  await graceSleep(timing, killGraceMs, signal);

  const remaining = await holdersUntil(marker, inspector, timing, timing.now() + killGraceMs, signal);
  const stillInGroup = groupVerified && isProcessAlive(-pgid, kill) && remaining.length > 0 && (await holderGroups(remaining, [pgid], inspector)).includes(pgid);
  const killTargets = [...(stillInGroup ? [-pgid] : []), ...remaining];
  for (const pid of signalTargets(kill, killTargets, 'SIGKILL')) unsignalled.add(pid);

  const notes: string[] = [];
  if (unsignalled.size > 0) notes.push(`Could not signal process ${[...unsignalled].join(', ')}.`);
  const leftAloneGroup = groupVerified && !stillInGroup && isProcessAlive(-pgid, kill) ? pgid : undefined;
  const leftAlonePids = holders.filter((pid) => !remaining.includes(pid) && isProcessAlive(pid, kill));
  const leftAlone = [...(leftAloneGroup === undefined ? [] : [`group ${pgid}`]), ...leftAlonePids.map((pid) => `process ${pid}`)];
  if (leftAlone.length > 0) notes.push(`Still running but no longer verified as belonging to this call, so left alone: ${leftAlone.join(', ')}.`);
  return unknownResult(['The interrupted command was stopped.', ...notes].join(' '), true, {
    ...(leftAloneGroup === undefined ? {} : { leftAloneGroup }),
    leftAlonePids,
    unsignalledPids: [...unsignalled],
  });
};

export type ReapMarkedProcessesOptions = {
  marker: string;
  pgid?: number | undefined;
  killGraceMs: number;
  label: string;
  onWarning(message: string): void;
  kill?: SignalSender;
  timing?: ReapTiming;
  signal?: AbortSignal;
  inspector?: ProcessInspector;
};

const MARKER_CONTENT = /^\d+\n?$/;

export const MARKER_READ_MAX_BYTES = 32;

const readRecordedGroup = async (marker: string): Promise<number | undefined> => {
  const handle = await fs.promises.open(marker, fs.constants.O_RDONLY | noFollowFlag());
  let content: string;
  try {
    const buffer = Buffer.alloc(MARKER_READ_MAX_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    content = bytesRead > MARKER_READ_MAX_BYTES ? '' : buffer.toString('utf8', 0, bytesRead);
  } finally {
    await handle.close();
  }
  return MARKER_CONTENT.test(content) ? Number(content.trim()) : undefined;
};

const lstatIfPresent = async (target: string): Promise<fs.Stats | undefined> => {
  try {
    return await fs.promises.lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
};

type HolderPass = { unsignalled: Set<number>; dropped: number[]; signalled: boolean };

const signalHoldersOnly = async (
  marker: string,
  killGraceMs: number,
  kill: SignalSender,
  timing: ReapTiming,
  signal: AbortSignal | undefined,
  inspector: ProcessInspector,
): Promise<HolderPass> => {
  const deadline = timing.now() + killGraceMs;
  const holders = (await holdersUntil(marker, inspector, timing, deadline, signal)).filter((pid) => pid > 1);
  const unsignalled = new Set(signalTargets(kill, holders, 'SIGTERM'));
  let remaining = await holdersUntil(marker, inspector, timing, deadline, signal);
  while (remaining.length > 0 && timing.now() < deadline && !isAborted(signal)) {
    await timing.sleep(REAP_POLL_INTERVAL_MS);
    remaining = await holdersUntil(marker, inspector, timing, deadline, signal);
  }
  const dropped = holders.filter((pid) => !remaining.includes(pid) && isProcessAlive(pid, kill));
  for (const pid of signalTargets(kill, remaining.filter((pid) => pid > 1), 'SIGKILL')) unsignalled.add(pid);
  return { unsignalled, dropped, signalled: holders.length > 0 };
};

const joinPids = (pids: readonly number[]): string => pids.join(', ');

const reapObserved = async ({
  marker,
  pgid,
  killGraceMs,
  label,
  onWarning,
  kill = defaultKill,
  timing = hostReapTiming,
  signal,
  inspector = defaultProcessInspector(),
}: ReapMarkedProcessesOptions): Promise<{ removed: boolean; stopped: boolean }> => {
  const stat = await lstatIfPresent(marker);
  if (stat === undefined) return { removed: true, stopped: false };
  if (!stat.isFile()) {
    await fs.promises.unlink(marker);
    onWarning(`${label} marker ${marker} was not a regular file, so it was removed without being followed`);
    return { removed: true, stopped: false };
  }
  const recorded = pgid ?? (await readRecordedGroup(marker));
  const ownGroup = (await holderGroups([process.pid], recorded === undefined ? [] : [recorded], inspector))[0];
  let stopped: boolean;
  if (recorded !== undefined && recorded > 1 && recorded !== ownGroup) {
    const result = await reconcileProcessGroup({ pgid: recorded, marker }, { killGraceMs, kill, timing, inspector, ...(signal === undefined ? {} : { signal }) });
    stopped = result.stopped;
    if (result.leftAloneGroup !== undefined) {
      onWarning(`${label} marker ${marker}: group ${result.leftAloneGroup} is still alive but no marker holder is in it, so it was left alone`);
    }
    if (result.leftAlonePids.length > 0) {
      onWarning(`${label} marker ${marker}: process ${joinPids(result.leftAlonePids)} dropped the marker but is still alive, so it was left alone`);
    }
    if (result.unsignalledPids.length > 0) {
      onWarning(`${label} marker ${marker}: could not signal process ${joinPids(result.unsignalledPids)}`);
    }
  } else {
    const { unsignalled, dropped, signalled } = await signalHoldersOnly(marker, killGraceMs, kill, timing, signal, inspector);
    stopped = signalled;
    if (dropped.length > 0) {
      onWarning(`${label} marker ${marker}: process ${joinPids(dropped)} dropped the marker but is still alive, so it was left alone`);
    }
    if (unsignalled.size > 0) {
      onWarning(`${label} marker ${marker}: could not signal process ${joinPids([...unsignalled])}`);
    }
  }
  const deadline = timing.now() + killGraceMs;
  let remaining = await holdersUntil(marker, inspector, timing, deadline, undefined);
  while (remaining.length > 0 && timing.now() < deadline) {
    await timing.sleep(REAP_POLL_INTERVAL_MS);
    remaining = await holdersUntil(marker, inspector, timing, deadline, undefined);
  }
  if (remaining.length > 0) {
    onWarning(`${label} marker ${marker} kept: process ${joinPids(remaining)} still hold it after cleanup; the next start will retry`);
    return { removed: false, stopped };
  }
  await fs.promises.rm(marker, { force: true });
  return { removed: true, stopped };
};

export type ReapReport = { removed: boolean; stopped: boolean; uninspectable: UninspectableProcess[] };

const observing = (inspector: ProcessInspector, found: Map<number, string>): ProcessInspector => ({
  startTimeOf: (pid) => inspector.startTimeOf(pid),
  holdersOf: (marker) => inspector.holdersOf(marker, (process) => void found.set(process.pid, process.command)),
  groupsOf: (pids, candidateGroups) => inspector.groupsOf(pids, candidateGroups),
});

export const reapMarkedProcessesWithReport = async (options: ReapMarkedProcessesOptions): Promise<ReapReport> => {
  const found = new Map<number, string>();
  const outcome = await reapObserved({ ...options, inspector: observing(options.inspector ?? defaultProcessInspector(), found) });
  const uninspectable = [...found].map(([pid, command]) => ({ pid, command }));
  if (uninspectable.length > 0) {
    options.onWarning(
      `${options.label} marker ${options.marker}: process ${uninspectable.map((process) => `${process.pid} (${process.command})`).join(', ')} could not be inspected, so it was left alone`,
    );
  }
  return { ...outcome, uninspectable };
};

export const reapMarkedProcesses = async (options: ReapMarkedProcessesOptions): Promise<{ removed: boolean }> => {
  const { removed } = await reapMarkedProcessesWithReport(options);
  return { removed };
};

export type ReapMarkerDirectoryOptions = {
  dir: string;
  killGraceMs: number;
  label: string;
  onWarning(message: string): void;
  kill?: SignalSender;
  timing?: ReapTiming;
  signal?: AbortSignal;
  inspector?: ProcessInspector;
};

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export class MarkerReapError extends AggregateError {
  readonly dir: string;

  constructor(dir: string, label: string, failures: ReadonlyArray<{ marker: string; reason: unknown }>) {
    super(
      failures.map((failure) => failure.reason),
      `${label} markers in ${dir} could not be reaped: ${failures.map((failure) => `${failure.marker}: ${messageOf(failure.reason)}`).join('; ')}`,
    );
    this.name = 'MarkerReapError';
    this.dir = dir;
  }
}

export const reapMarkerDirectory = async ({
  dir,
  killGraceMs,
  label,
  onWarning,
  kill,
  timing,
  signal,
  inspector,
}: ReapMarkerDirectoryOptions): Promise<{ reaped: number; kept: number }> => {
  let names: string[];
  try {
    names = await fs.promises.readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { reaped: 0, kept: 0 };
    throw error;
  }
  const markers = names.map((name) => path.join(dir, name));
  const outcomes = await Promise.all(
    markers.map(async (marker): Promise<{ marker: string; removed: boolean } | { marker: string; failure: unknown }> => {
      try {
        const { removed } = await reapMarkedProcesses({ marker, killGraceMs, label, onWarning, ...(kill === undefined ? {} : { kill }), ...(timing === undefined ? {} : { timing }), ...(signal === undefined ? {} : { signal }), ...(inspector === undefined ? {} : { inspector }) });
        return { marker, removed };
      } catch (failure) {
        return { marker, failure };
      }
    }),
  );
  let reaped = 0;
  let kept = 0;
  const failures: Array<{ marker: string; reason: unknown }> = [];
  for (const outcome of outcomes) {
    if ('failure' in outcome) failures.push({ marker: outcome.marker, reason: outcome.failure });
    else if (outcome.removed) reaped += 1;
    else kept += 1;
  }
  if (failures.length > 0) throw new MarkerReapError(dir, label, failures);
  return { reaped, kept };
};
