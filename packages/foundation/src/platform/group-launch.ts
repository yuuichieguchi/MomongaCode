import type { LaunchProtection } from '../child-protection.ts';
import { spawn } from 'node:child_process';
import type { ChildProcess, StdioOptions } from 'node:child_process';
import { closeDescriptorSync, openReadOnlySync } from '../node-file-system.ts';
import { hostProcessGroupPort } from './group-port.ts';
import type { GroupKeeper, ProcessGroupPort } from './group-port.ts';
import type { KeptExit } from './windows-kept-groups.ts';

export type LaunchSlot = 'ignore' | 'pipe' | 'inherit' | number;

export type GroupLaunchMarker = { slot: number; file: string; descriptor?: number } | { slot: number; file?: undefined; descriptor: number };

export type GroupLaunchRequest = {
  file: string;
  args: readonly string[];
  cwd?: string;
  env?: Readonly<Record<string, string>>;
  stdio: readonly LaunchSlot[];
  marker?: GroupLaunchMarker;
  port?: ProcessGroupPort;
  spawnProcess?: typeof spawn;
  protection: LaunchProtection;
};

export type GroupLaunchHost = { port?: ProcessGroupPort; spawnProcess?: typeof spawn };

export type LeaderExit = { code: number | null; signal: NodeJS.Signals | null };

export type GroupLaunch = {
  readonly child: ChildProcess;
  readonly pgid: number | undefined;
  onExit(exited: (exit: LeaderExit) => void, failed: (error: Error) => void): void;
  onStart(started: (commandPid: number) => void): void;
};

type SpawnPlace = { cwd?: string; env?: Record<string, string> };

const placeOf = ({ cwd, env }: GroupLaunchRequest): SpawnPlace => ({ ...(cwd === undefined ? {} : { cwd }), ...(env === undefined ? {} : { env: { ...env } }) });

const exitCodeOf = (child: ChildProcess): Promise<number | undefined> =>
  new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolve(code ?? undefined));
  });

const leaderExitOf = (exit: KeptExit): LeaderExit => (exit.kind === 'exit' ? { code: exit.code, signal: null } : { code: null, signal: 'SIGKILL' });

const STANDARD_SLOTS = 3;

const descriptorsBeyondStandard = (stdio: readonly LaunchSlot[]): number[] => stdio.flatMap((slot, descriptor) => (descriptor >= STANDARD_SLOTS && slot !== 'ignore' ? [descriptor] : []));

const launchKept = async (keeper: GroupKeeper, request: GroupLaunchRequest, spawnProcess: typeof spawn): Promise<GroupLaunch> => {
  const { marker } = request;
  if (marker !== undefined && marker.file === undefined) throw new Error(`the marker of ${request.file} reaches a kept command by its path, and only a descriptor was given`);
  const stdio: LaunchSlot[] = [...request.stdio];
  if (marker !== undefined && marker.slot < stdio.length) stdio[marker.slot] = 'ignore';
  const opening = await keeper.open({
    command: { file: request.file, args: request.args },
    marker: marker?.file,
    descriptors: descriptorsBeyondStandard(stdio),
    start: (executable, args, verbatim) => {
      const verbatimForm = verbatim === true ? { windowsVerbatimArguments: true, argv0: `"${executable}"` } : {};
      const child = spawnProcess(executable, [...args], { ...placeOf(request), ...verbatimForm, detached: true, windowsHide: true, stdio });
      return { child, pid: child.pid, exited: exitCodeOf(child) };
    },
  });
  const { child } = opening.process;
  let commandPid: number | undefined;
  const startListeners: ((commandPid: number) => void)[] = [];
  const started = opening.commandPid.then((pid) => {
    commandPid = pid;
    for (const listener of startListeners.splice(0)) listener(pid);
  });
  const ended = Promise.all([started, opening.commandExit]).then(([, exit]) => leaderExitOf(exit));
  ended.catch(() => undefined);
  return {
    child,
    pgid: child.pid,
    onExit: (exited, failed) => {
      ended.then(exited, (error: unknown) => failed(error instanceof Error ? error : new Error(String(error))));
    },
    onStart: (started) => {
      if (commandPid === undefined) startListeners.push(started);
      else started(commandPid);
    },
  };
};

const launchDirect = (request: GroupLaunchRequest, spawnProcess: typeof spawn): GroupLaunch => {
  const { marker } = request;
  const opened = marker !== undefined && marker.file !== undefined && marker.descriptor === undefined ? openReadOnlySync(marker.file) : undefined;
  let child: ChildProcess;
  try {
    const stdio: LaunchSlot[] = [...request.stdio];
    const descriptor = marker?.descriptor ?? opened;
    if (marker !== undefined && descriptor !== undefined) stdio[marker.slot] = descriptor;
    child = spawnProcess(request.file, [...request.args], { ...placeOf(request), detached: true, windowsHide: true, stdio });
  } finally {
    if (opened !== undefined) closeDescriptorSync(opened);
  }
  return {
    child,
    pgid: child.pid,
    onExit: (exited) => {
      child.once('exit', (code, signal) => exited({ code, signal }));
    },
    onStart: (started) => {
      if (child.pid !== undefined) started(child.pid);
    },
  };
};

const insidePromiseJob = async (): Promise<void> => undefined;

export const launchGroupLeader = async (request: GroupLaunchRequest): Promise<GroupLaunch> => {
  const spawnProcess = request.spawnProcess ?? spawn;
  const { keeper } = request.port ?? hostProcessGroupPort();
  if (keeper !== undefined) return launchKept(keeper, request, spawnProcess);
  // Node emits a spawn error on process.nextTick; started inside a promise job, it waits until the awaiting caller has attached its listener.
  await insidePromiseJob();
  return launchDirect(request, spawnProcess);
};

export type ApartOptions = { cwd?: string; env?: Readonly<Record<string, string | undefined>>; stdio: StdioOptions; windowsHide?: boolean };

export const launchApart = (file: string, args: readonly string[], options: ApartOptions, spawnProcess: typeof spawn = spawn): ChildProcess => {
  const { env, ...rest } = options;
  return spawnProcess(file, [...args], { ...rest, ...(env === undefined ? {} : { env: { ...env } }), detached: true });
};
