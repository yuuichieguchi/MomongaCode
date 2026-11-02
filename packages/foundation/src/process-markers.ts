import fs from 'node:fs';
import path from 'node:path';
import { isProcessAlive } from './process-alive.ts';
import type { SignalSender } from './process-alive.ts';
import { hostSignalSender } from './platform/group-port.ts';
import type { ProcessInspector } from './platform/inspector-types.ts';
import { defaultProcessInspector } from './platform/process-inspector.ts';

export type ReapTiming = {
  now(): number;
  sleep(ms: number): Promise<void>;
};

const realTiming: ReapTiming = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

const defaultKill: SignalSender = hostSignalSender;

export const REAP_POLL_INTERVAL_MS = 25;

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
  (await inspector.holdersOf(marker)).filter((pid) => pid !== process.pid);

const groupsByHolder = (holders: readonly number[], candidateGroups: readonly number[], inspector: ProcessInspector): Promise<Map<number, number>> =>
  inspector.groupsOf(holders, candidateGroups);

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

export type MarkerReconcileResult = { outcome: 'unknown'; output: string; leftAloneGroup?: number; leftAlonePids: number[]; unsignalledPids: number[] };

type StructuredFindings = { leftAloneGroup?: number; leftAlonePids?: number[]; unsignalledPids?: number[] };

const unknownResult = (detail: string, { leftAloneGroup, leftAlonePids = [], unsignalledPids = [] }: StructuredFindings = {}): MarkerReconcileResult => ({
  outcome: 'unknown',
  output: `${detail} The effect of the interrupted command is unknown; inspect the current state before retrying it.`,
  ...(leftAloneGroup === undefined ? {} : { leftAloneGroup }),
  leftAlonePids,
  unsignalledPids,
});

export const reconcileProcessGroup = async (
  recorded: { pgid: number; marker: string },
  {
    killGraceMs = 2000,
    kill = defaultKill,
    timing = realTiming,
    signal,
    inspector = defaultProcessInspector(),
  }: { killGraceMs?: number; kill?: SignalSender; timing?: ReapTiming; signal?: AbortSignal; inspector?: ProcessInspector } = {},
): Promise<MarkerReconcileResult> => {
  const { pgid, marker } = recorded;
  const holders = await findHolders(marker, inspector);
  const groupAlive = isProcessAlive(-pgid, kill);
  if (!groupAlive && holders.length === 0) return unknownResult('The interrupted command is no longer running.');
  if (holders.length === 0) {
    return unknownResult(
      `Processes in group ${pgid} are still running but could not be verified as belonging to this call (for example they closed the inherited descriptor), so they were left alone.`,
      { leftAloneGroup: pgid },
    );
  }
  const holderGroup = groupAlive ? await groupsByHolder(holders, [pgid], inspector) : new Map<number, number>();
  const groupVerified = [...holderGroup.values()].includes(pgid);
  const holdersOutsideGroup = groupVerified ? holders.filter((pid) => holderGroup.get(pid) !== pgid) : holders;
  const termTargets = [...(groupVerified ? [-pgid] : []), ...holdersOutsideGroup];
  const unsignalled = new Set(signalTargets(kill, termTargets, 'SIGTERM'));
  await graceSleep(timing, killGraceMs, signal);

  const remaining = await findHolders(marker, inspector);
  const stillInGroup = groupVerified && isProcessAlive(-pgid, kill) && remaining.length > 0 && (await holderGroups(remaining, [pgid], inspector)).includes(pgid);
  const killTargets = [...(stillInGroup ? [-pgid] : []), ...remaining];
  for (const pid of signalTargets(kill, killTargets, 'SIGKILL')) unsignalled.add(pid);

  const notes: string[] = [];
  if (unsignalled.size > 0) notes.push(`Could not signal process ${[...unsignalled].join(', ')}.`);
  const leftAloneGroup = groupVerified && !stillInGroup && isProcessAlive(-pgid, kill) ? pgid : undefined;
  const leftAlonePids = holders.filter((pid) => !remaining.includes(pid) && isProcessAlive(pid, kill));
  const leftAlone = [...(leftAloneGroup === undefined ? [] : [`group ${pgid}`]), ...leftAlonePids.map((pid) => `process ${pid}`)];
  if (leftAlone.length > 0) notes.push(`Still running but no longer verified as belonging to this call, so left alone: ${leftAlone.join(', ')}.`);
  return unknownResult(['The interrupted command was stopped.', ...notes].join(' '), {
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

const readRecordedGroup = async (marker: string): Promise<number | undefined> => {
  const content = await fs.promises.readFile(marker, 'utf8');
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

type HolderPass = { unsignalled: Set<number>; dropped: number[] };

const signalHoldersOnly = async (
  marker: string,
  killGraceMs: number,
  kill: SignalSender,
  timing: ReapTiming,
  signal: AbortSignal | undefined,
  inspector: ProcessInspector,
): Promise<HolderPass> => {
  const holders = (await findHolders(marker, inspector)).filter((pid) => pid > 1);
  const unsignalled = new Set(signalTargets(kill, holders, 'SIGTERM'));
  const deadline = timing.now() + killGraceMs;
  let remaining = await findHolders(marker, inspector);
  while (remaining.length > 0 && timing.now() < deadline && !isAborted(signal)) {
    await timing.sleep(REAP_POLL_INTERVAL_MS);
    remaining = await findHolders(marker, inspector);
  }
  const dropped = holders.filter((pid) => !remaining.includes(pid) && isProcessAlive(pid, kill));
  for (const pid of signalTargets(kill, remaining.filter((pid) => pid > 1), 'SIGKILL')) unsignalled.add(pid);
  return { unsignalled, dropped };
};

const joinPids = (pids: readonly number[]): string => pids.join(', ');

export const reapMarkedProcesses = async ({
  marker,
  pgid,
  killGraceMs,
  label,
  onWarning,
  kill = defaultKill,
  timing = realTiming,
  signal,
  inspector = defaultProcessInspector(),
}: ReapMarkedProcessesOptions): Promise<{ removed: boolean }> => {
  const stat = await lstatIfPresent(marker);
  if (stat === undefined) return { removed: true };
  if (!stat.isFile()) {
    await fs.promises.unlink(marker);
    onWarning(`${label} marker ${marker} was not a regular file, so it was removed without being followed`);
    return { removed: true };
  }
  const recorded = pgid ?? (await readRecordedGroup(marker));
  const ownGroup = (await holderGroups([process.pid], recorded === undefined ? [] : [recorded], inspector))[0];
  if (recorded !== undefined && recorded > 1 && recorded !== ownGroup) {
    const result = await reconcileProcessGroup({ pgid: recorded, marker }, { killGraceMs, kill, timing, inspector, ...(signal === undefined ? {} : { signal }) });
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
    const { unsignalled, dropped } = await signalHoldersOnly(marker, killGraceMs, kill, timing, signal, inspector);
    if (dropped.length > 0) {
      onWarning(`${label} marker ${marker}: process ${joinPids(dropped)} dropped the marker but is still alive, so it was left alone`);
    }
    if (unsignalled.size > 0) {
      onWarning(`${label} marker ${marker}: could not signal process ${joinPids([...unsignalled])}`);
    }
  }
  const deadline = timing.now() + killGraceMs;
  let remaining = await findHolders(marker, inspector);
  while (remaining.length > 0 && timing.now() < deadline) {
    await timing.sleep(REAP_POLL_INTERVAL_MS);
    remaining = await findHolders(marker, inspector);
  }
  if (remaining.length > 0) {
    onWarning(`${label} marker ${marker} kept: process ${joinPids(remaining)} still hold it after cleanup; the next start will retry`);
    return { removed: false };
  }
  await fs.promises.rm(marker, { force: true });
  return { removed: true };
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
    onWarning(`${label} marker directory ${dir} could not be read: ${messageOf(error)}`);
    return { reaped: 0, kept: 0 };
  }
  const markers = names.map((name) => path.join(dir, name));
  const settled = await Promise.allSettled(
    markers.map((marker) => reapMarkedProcesses({ marker, killGraceMs, label, onWarning, ...(kill === undefined ? {} : { kill }), ...(timing === undefined ? {} : { timing }), ...(signal === undefined ? {} : { signal }), ...(inspector === undefined ? {} : { inspector }) })),
  );
  let reaped = 0;
  let kept = 0;
  settled.forEach((outcome, index) => {
    if (outcome.status === 'rejected') onWarning(`${label} marker ${markers[index]} could not be reaped: ${messageOf(outcome.reason)}`);
    else if (outcome.value.removed) reaped += 1;
    else kept += 1;
  });
  return { reaped, kept };
};
