import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { isProcessAlive } from './process-alive.ts';
import type { SignalSender } from './process-alive.ts';

const ROW_FORMAT = /^\s*(\d+)\s+(\d+)\s*$/;

export type ReapTiming = {
  now(): number;
  sleep(ms: number): Promise<void>;
};

const realTiming: ReapTiming = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

const defaultKill: SignalSender = (pid, signal) => void process.kill(pid, signal);

const POLL_INTERVAL_MS = 25;

const runTool = (file: string, args: readonly string[]): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(file, [...args], { env: { LC_ALL: 'C' } }, (error, stdout) => {
      if (error === null) resolve(stdout);
      else if (String(error.code) === '1') resolve('');
      else reject(error);
    });
  });

export const findHolders = async (marker: string): Promise<number[]> => {
  const output = await runTool('/usr/sbin/lsof', ['-t', '--', marker]);
  return output
    .split('\n')
    .filter((line) => /^\d+$/.test(line.trim()))
    .map((line) => Number(line.trim()))
    .filter((pid) => pid !== process.pid);
};

const groupsByHolder = async (holders: readonly number[]): Promise<Map<number, number>> => {
  const output = await runTool('/bin/ps', ['-o', 'pid=,pgid=', '-p', holders.join(',')]);
  return new Map(
    output.split('\n').flatMap((line): Array<[number, number]> => {
      const match = ROW_FORMAT.exec(line);
      return match === null ? [] : [[Number(match[1]), Number(match[2])]];
    }),
  );
};

export const holderGroups = async (holders: readonly number[]): Promise<number[]> => [...(await groupsByHolder(holders)).values()];

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
  { killGraceMs = 2000, kill = defaultKill, timing = realTiming }: { killGraceMs?: number; kill?: SignalSender; timing?: ReapTiming } = {},
): Promise<MarkerReconcileResult> => {
  const { pgid, marker } = recorded;
  const holders = await findHolders(marker);
  const groupAlive = isProcessAlive(-pgid, kill);
  if (!groupAlive && holders.length === 0) return unknownResult('The interrupted command is no longer running.');
  if (holders.length === 0) {
    return unknownResult(
      `Processes in group ${pgid} are still running but could not be verified as belonging to this call (for example they closed the inherited descriptor), so they were left alone.`,
      { leftAloneGroup: pgid },
    );
  }
  const holderGroup = groupAlive ? await groupsByHolder(holders) : new Map<number, number>();
  const groupVerified = [...holderGroup.values()].includes(pgid);
  const holdersOutsideGroup = groupVerified ? holders.filter((pid) => holderGroup.get(pid) !== pgid) : holders;
  const termTargets = [...(groupVerified ? [-pgid] : []), ...holdersOutsideGroup];
  const unsignalled = new Set(signalTargets(kill, termTargets, 'SIGTERM'));
  await timing.sleep(killGraceMs);

  const remaining = await findHolders(marker);
  const stillInGroup = groupVerified && isProcessAlive(-pgid, kill) && remaining.length > 0 && (await holderGroups(remaining)).includes(pgid);
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
): Promise<HolderPass> => {
  const holders = (await findHolders(marker)).filter((pid) => pid > 1);
  const unsignalled = new Set(signalTargets(kill, holders, 'SIGTERM'));
  const deadline = timing.now() + killGraceMs;
  let remaining = await findHolders(marker);
  while (remaining.length > 0 && timing.now() < deadline) {
    await timing.sleep(POLL_INTERVAL_MS);
    remaining = await findHolders(marker);
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
}: ReapMarkedProcessesOptions): Promise<{ removed: boolean }> => {
  const stat = await lstatIfPresent(marker);
  if (stat === undefined) return { removed: true };
  if (!stat.isFile()) {
    await fs.promises.unlink(marker);
    onWarning(`${label} marker ${marker} was not a regular file, so it was removed without being followed`);
    return { removed: true };
  }
  const recorded = pgid ?? (await readRecordedGroup(marker));
  const ownGroup = (await holderGroups([process.pid]))[0];
  if (recorded !== undefined && recorded > 1 && recorded !== ownGroup) {
    const result = await reconcileProcessGroup({ pgid: recorded, marker }, { killGraceMs, kill, timing });
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
    const { unsignalled, dropped } = await signalHoldersOnly(marker, killGraceMs, kill, timing);
    if (dropped.length > 0) {
      onWarning(`${label} marker ${marker}: process ${joinPids(dropped)} dropped the marker but is still alive, so it was left alone`);
    }
    if (unsignalled.size > 0) {
      onWarning(`${label} marker ${marker}: could not signal process ${joinPids([...unsignalled])}`);
    }
  }
  const deadline = timing.now() + killGraceMs;
  let remaining = await findHolders(marker);
  while (remaining.length > 0 && timing.now() < deadline) {
    await timing.sleep(POLL_INTERVAL_MS);
    remaining = await findHolders(marker);
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
};

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export const reapMarkerDirectory = async ({
  dir,
  killGraceMs,
  label,
  onWarning,
  kill,
  timing,
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
    markers.map((marker) => reapMarkedProcesses({ marker, killGraceMs, label, onWarning, ...(kill === undefined ? {} : { kill }), ...(timing === undefined ? {} : { timing }) })),
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
