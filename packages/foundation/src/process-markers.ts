import fs from 'node:fs';
import path from 'node:path';
import type { SignalSender } from './process-alive.ts';
import { hostAsyncSignalSender } from './platform/group-port.ts';
import type { AsyncSignalSender } from './platform/group-port.ts';
import { ProbeFailedError, valueOrThrow } from './platform/inspector-types.ts';
import { noFollowFlag } from './platform/privacy.ts';
import { REAP_POLL_INTERVAL_MS, hostProbeTiming } from './platform/probe-timing.ts';
import type { ProbeTiming } from './platform/probe-timing.ts';
import type { ProcessInspector, UninspectableProcess } from './platform/inspector-types.ts';
import { defaultProcessInspector } from './platform/process-inspector.ts';
import { defaultUninspectableRegistry } from './uninspectable-registry.ts';
import type { UninspectableRegistry } from './uninspectable-registry.ts';

export type ReapTiming = ProbeTiming;

export const hostReapTiming: ReapTiming = hostProbeTiming;

export { REAP_POLL_INTERVAL_MS };

const NEVER_ABORTED = new AbortController().signal;


const asyncSenderOf = (kill: SignalSender | undefined): AsyncSignalSender =>
  kill === undefined
    ? hostAsyncSignalSender
    : async (target, signal) => {
        kill(target, signal);
      };

const aliveVia = async (send: AsyncSignalSender, target: number, signal: AbortSignal): Promise<boolean> => {
  try {
    await send(target, 0, { signal });
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true;
    throw error;
  }
};

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

export type FindHoldersOptions = { signal: AbortSignal; inspector?: ProcessInspector; onUninspectable?: (process: UninspectableProcess) => void };

export const findHolders = async (marker: string, { signal, inspector = defaultProcessInspector(), onUninspectable }: FindHoldersOptions): Promise<number[]> =>
  valueOrThrow(`listing the holders of ${marker}`, await inspector.holdersOf(marker, { signal }, onUninspectable), []).filter((pid) => pid !== process.pid);

const uninspectableWarning = (context: string, processes: readonly UninspectableProcess[]): string =>
  `${context}: process ${processes.map((process) => `${process.pid} (${process.command})`).join(', ')} could not be inspected, so it was left alone`;

export const reportUninspectableOnce =
  (onWarning: (message: string) => void, context: string, registry: UninspectableRegistry = defaultUninspectableRegistry) =>
  (process: UninspectableProcess): void => {
    if (registry.firstNaming(context, process)) onWarning(uninspectableWarning(context, [process]));
  };

const groupsByHolder = async (holders: readonly number[], candidateGroups: readonly number[], inspector: ProcessInspector, signal: AbortSignal): Promise<Map<number, number>> =>
  valueOrThrow(`reading the process groups of ${holders.join(',')}`, await inspector.groupsOf(holders, candidateGroups, { signal }), new Map<number, number>());

type Listing = { inspector: ProcessInspector; timing: ReapTiming; signal: AbortSignal; escalate: AbortSignal | undefined };

const holdersUntil = async (marker: string, listing: Listing, deadline: number, unsettled?: Map<number, UninspectableProcess>): Promise<number[]> => {
  const { inspector, timing, signal, escalate } = listing;
  for (;;) {
    const refusing = new Map<number, UninspectableProcess>();
    try {
      const holders = await findHolders(marker, { signal, inspector, onUninspectable: (process) => void refusing.set(process.pid, process) });
      if (unsettled === undefined || refusing.size === 0 || holders.length > 0 || timing.now() >= deadline || isAborted(escalate)) {
        unsettled?.clear();
        for (const [pid, process] of refusing) unsettled?.set(pid, process);
        return holders;
      }
    } catch (error) {
      const retryable = error instanceof ProbeFailedError && error.probeCause === 'transient' && timing.now() < deadline && !isAborted(escalate);
      if (!retryable) throw error;
    }
    await timing.sleep(REAP_POLL_INTERVAL_MS);
  }
};

export const holderGroups = async (
  holders: readonly number[],
  candidateGroups: readonly number[] = [],
  { signal, inspector = defaultProcessInspector() }: { signal: AbortSignal; inspector?: ProcessInspector },
): Promise<number[]> => [...(await groupsByHolder(holders, candidateGroups, inspector, signal)).values()];

const signalTargets = async (send: AsyncSignalSender, targets: readonly number[], signal: NodeJS.Signals, stop: AbortSignal): Promise<number[]> => {
  const unsignalled: number[] = [];
  for (const target of targets) {
    try {
      await send(target, signal, { signal: stop });
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

export type ReconcileProcessGroupOptions = {
  killGraceMs?: number;
  kill?: SignalSender;
  timing?: ReapTiming;
  signal?: AbortSignal;
  inspector?: ProcessInspector;
  unsettled?: Map<number, UninspectableProcess>;
};

export const reconcileProcessGroup = async (
  recorded: { pgid: number; marker: string },
  { killGraceMs = 2000, kill, timing = hostReapTiming, signal, inspector = defaultProcessInspector(), unsettled }: ReconcileProcessGroupOptions = {},
): Promise<MarkerReconcileResult> => {
  const { pgid, marker } = recorded;
  const send = asyncSenderOf(kill);
  const stop = NEVER_ABORTED;
  const listing: Listing = { inspector, timing, signal: stop, escalate: signal };
  const holders = await holdersUntil(marker, listing, timing.now() + killGraceMs, unsettled);
  const groupAlive = await aliveVia(send, -pgid, stop);
  if (!groupAlive && holders.length === 0) return unknownResult('The interrupted command is no longer running.', false);
  if (holders.length === 0) {
    return unknownResult(
      `Processes in group ${pgid} are still running but could not be verified as belonging to this call (for example they closed the inherited descriptor), so they were left alone.`,
      false,
      { leftAloneGroup: pgid },
    );
  }
  const holderGroup = groupAlive ? await groupsByHolder(holders, [pgid], inspector, stop) : new Map<number, number>();
  const groupVerified = [...holderGroup.values()].includes(pgid);
  const holdersOutsideGroup = groupVerified ? holders.filter((pid) => holderGroup.get(pid) !== pgid) : holders;
  const termTargets = [...(groupVerified ? [-pgid] : []), ...holdersOutsideGroup];
  const unsignalled = new Set(await signalTargets(send, termTargets, 'SIGTERM', stop));
  await graceSleep(timing, killGraceMs, signal);

  const remaining = await holdersUntil(marker, listing, timing.now() + killGraceMs, unsettled);
  const stillInGroup = groupVerified && (await aliveVia(send, -pgid, stop)) && remaining.length > 0 && (await holderGroups(remaining, [pgid], { signal: stop, inspector })).includes(pgid);
  const killTargets = [...(stillInGroup ? [-pgid] : []), ...remaining];
  for (const pid of await signalTargets(send, killTargets, 'SIGKILL', stop)) unsignalled.add(pid);

  const notes: string[] = [];
  if (unsignalled.size > 0) notes.push(`Could not signal process ${[...unsignalled].join(', ')}.`);
  const leftAloneGroup = groupVerified && !stillInGroup && (await aliveVia(send, -pgid, stop)) ? pgid : undefined;
  const leftAlonePids: number[] = [];
  for (const pid of holders) if (!remaining.includes(pid) && (await aliveVia(send, pid, stop))) leftAlonePids.push(pid);
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
  uninspectable?: UninspectableRegistry;
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

export type ReapReport = { removed: boolean; stopped: boolean; uninspectable: UninspectableProcess[] };

type HolderPass = { unsignalled: Set<number>; dropped: number[]; signalled: boolean };

const signalHoldersOnly = async (
  marker: string,
  killGraceMs: number,
  send: AsyncSignalSender,
  timing: ReapTiming,
  signal: AbortSignal | undefined,
  inspector: ProcessInspector,
  unsettled: Map<number, UninspectableProcess>,
): Promise<HolderPass> => {
  const stop = NEVER_ABORTED;
  const listing: Listing = { inspector, timing, signal: stop, escalate: signal };
  const deadline = timing.now() + killGraceMs;
  const holders = (await holdersUntil(marker, listing, deadline, unsettled)).filter((pid) => pid > 1);
  const unsignalled = new Set(await signalTargets(send, holders, 'SIGTERM', stop));
  let remaining = await holdersUntil(marker, listing, deadline, unsettled);
  while (remaining.length > 0 && timing.now() < deadline && !isAborted(signal)) {
    await timing.sleep(REAP_POLL_INTERVAL_MS);
    remaining = await holdersUntil(marker, listing, deadline, unsettled);
  }
  const dropped: number[] = [];
  for (const pid of holders) if (!remaining.includes(pid) && (await aliveVia(send, pid, stop))) dropped.push(pid);
  for (const pid of await signalTargets(send, remaining.filter((pid) => pid > 1), 'SIGKILL', stop)) unsignalled.add(pid);
  return { unsignalled, dropped, signalled: holders.length > 0 };
};

const joinPids = (pids: readonly number[]): string => pids.join(', ');

const reapObserved = async ({
  marker,
  pgid,
  killGraceMs,
  label,
  onWarning,
  kill,
  timing = hostReapTiming,
  signal,
  inspector = defaultProcessInspector(),
}: ReapMarkedProcessesOptions): Promise<ReapReport> => {
  const stop = NEVER_ABORTED;
  const send = asyncSenderOf(kill);
  const stat = await lstatIfPresent(marker);
  if (stat === undefined) return { removed: true, stopped: false, uninspectable: [] };
  if (!stat.isFile()) {
    await fs.promises.unlink(marker);
    onWarning(`${label} marker ${marker} was not a regular file, so it was removed without being followed`);
    return { removed: true, stopped: false, uninspectable: [] };
  }
  const recorded = pgid ?? (await readRecordedGroup(marker));
  const ownGroup = (await holderGroups([process.pid], recorded === undefined ? [] : [recorded], { signal: stop, inspector }))[0];
  const unsettled = new Map<number, UninspectableProcess>();
  let stopped: boolean;
  if (recorded !== undefined && recorded > 1 && recorded !== ownGroup) {
    const result = await reconcileProcessGroup({ pgid: recorded, marker }, { killGraceMs, ...(kill === undefined ? {} : { kill }), timing, inspector, unsettled, ...(signal === undefined ? {} : { signal }) });
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
    const { unsignalled, dropped, signalled } = await signalHoldersOnly(marker, killGraceMs, send, timing, signal, inspector, unsettled);
    stopped = signalled;
    if (dropped.length > 0) {
      onWarning(`${label} marker ${marker}: process ${joinPids(dropped)} dropped the marker but is still alive, so it was left alone`);
    }
    if (unsignalled.size > 0) {
      onWarning(`${label} marker ${marker}: could not signal process ${joinPids([...unsignalled])}`);
    }
  }
  const listing: Listing = { inspector, timing, signal: stop, escalate: undefined };
  const deadline = timing.now() + killGraceMs;
  let remaining = await holdersUntil(marker, listing, deadline, unsettled);
  while ((remaining.length > 0 || unsettled.size > 0) && timing.now() < deadline) {
    await timing.sleep(REAP_POLL_INTERVAL_MS);
    remaining = await holdersUntil(marker, listing, deadline, unsettled);
  }
  if (remaining.length > 0) {
    onWarning(`${label} marker ${marker} kept: process ${joinPids(remaining)} still hold it after cleanup; the next start will retry`);
    return { removed: false, stopped, uninspectable: [...unsettled.values()] };
  }
  if (unsettled.size > 0) return { removed: false, stopped, uninspectable: [...unsettled.values()] };
  await fs.promises.rm(marker, { force: true });
  return { removed: true, stopped, uninspectable: [] };
};

export const reapMarkedProcessesWithReport = async (options: ReapMarkedProcessesOptions): Promise<ReapReport> => {
  const outcome = await reapObserved(options);
  const context = `${options.label} marker ${options.marker}`;
  const registry = options.uninspectable ?? defaultUninspectableRegistry;
  const unnamed = outcome.uninspectable.filter((process) => registry.firstNaming(context, process));
  if (unnamed.length > 0) options.onWarning(uninspectableWarning(context, unnamed));
  return outcome;
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
