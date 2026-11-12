import { nodeCommandRunner } from './command-runner.ts';
import type { CommandRunner } from './command-runner.ts';
import type { SignalSender } from '../process-alive.ts';
import { createDarwinGroupStates } from './darwin-inspector.ts';
import { createLinuxGroupStates } from './linux-inspector.ts';
import { nodeProcFs } from './procfs.ts';
import type { ProcFs } from './procfs.ts';
import { canStillRun } from './run-state.ts';
import type { GroupReading, GroupStatesReader } from './run-state.ts';
import { UnsupportedPlatformError } from './process-inspector.ts';
import { hostKeptGroups } from './windows-kept-groups.ts';
import type { KeptGroupControl, KeptOpenRequest, KeptOpening, KeptProcess } from './windows-kept-groups.ts';

export type GroupProbeOptions = { signal: AbortSignal | undefined };

export type GroupSignals = readonly [NodeJS.Signals, ...NodeJS.Signals[]];

export const POSIX_GROUP_SIGNALS = ['SIGTERM', 'SIGKILL'] as const satisfies GroupSignals;

export const JOB_GROUP_SIGNALS = ['SIGTERM'] as const satisfies GroupSignals;

export type GroupIdentity = 'holder' | 'job';

export type GroupNames = {
  nameOf(pgid: number): string | undefined;
  recall(pgid: number, name: string): void;
};

export type GroupKeeper = {
  open<P extends KeptProcess>(request: KeptOpenRequest<P>): Promise<KeptOpening<P>>;
};

export interface ProcessGroupPort {
  readonly signals?: GroupSignals;
  readonly identity?: GroupIdentity;
  readonly names?: GroupNames;
  readonly keeper?: GroupKeeper;
  ended?(pgid: number, options: GroupProbeOptions): Promise<void>;
  signal(pgid: number, signal: NodeJS.Signals, options: GroupProbeOptions): Promise<void>;
  alive(pgid: number, options: GroupProbeOptions): Promise<boolean>;
}

export const groupSignalsOf = (port: ProcessGroupPort): GroupSignals => port.signals ?? POSIX_GROUP_SIGNALS;

const tolerated = (error: unknown): 'gone' | 'denied' | 'other' => {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'ESRCH') return 'gone';
  if (code === 'EPERM') return 'denied';
  return 'other';
};

export type PosixGroupHost = { kill: SignalSender; reading: GroupReading };

export const createPosixGroupPort = ({ kill, reading }: PosixGroupHost): ProcessGroupPort => ({
  signals: POSIX_GROUP_SIGNALS,
  identity: 'holder',
  signal: async (pgid, signal) => {
    try {
      kill(-pgid, signal);
    } catch (error) {
      if (tolerated(error) === 'other') throw error;
    }
  },
  alive: async (pgid, options) => {
    try {
      kill(-pgid, 0);
      if (reading.successMeansRunnable) return true;
    } catch (error) {
      const verdict = tolerated(error);
      if (verdict === 'other') throw error;
      if (verdict === 'gone') return false;
    }
    return (await reading.states(pgid, options)).some(canStillRun);
  },
});

export type GroupPortPorts = { run: CommandRunner; env: Readonly<Record<string, string | undefined>>; procfs?: ProcFs; kill?: SignalSender; kept?: KeptGroupControl };

const unsupportedStates =
  (platform: NodeJS.Platform): GroupStatesReader =>
  async () => {
    throw new UnsupportedPlatformError(platform, 'reading the run states of a process group');
  };

const groupReadingOf = (platform: NodeJS.Platform, ports: GroupPortPorts): GroupReading => {
  switch (platform) {
    case 'darwin':
      return { states: createDarwinGroupStates(ports.run), successMeansRunnable: true };
    case 'linux':
      return { states: createLinuxGroupStates(ports.procfs ?? nodeProcFs), successMeansRunnable: false };
    default:
      return { states: unsupportedStates(platform), successMeansRunnable: false };
  }
};

export const createJobGroupPort = (kept: KeptGroupControl): ProcessGroupPort => ({
  signals: JOB_GROUP_SIGNALS,
  identity: 'job',
  names: { nameOf: (pgid) => kept.nameOf(pgid), recall: (pgid, name) => kept.recall(pgid, name) },
  keeper: kept,
  ended: (pgid, options) => kept.ended(pgid, options),
  signal: (pgid, _signal, options) => kept.terminate(pgid, options),
  alive: async (pgid, options) => {
    const answer = await kept.members(pgid, options);
    return answer.kind === 'members' && answer.pids.length > 0;
  },
});

export const createProcessGroupPort = (platform: NodeJS.Platform, ports: GroupPortPorts): ProcessGroupPort => {
  if (platform !== 'win32') return createPosixGroupPort({ kill: ports.kill ?? hostSignalSender, reading: groupReadingOf(platform, ports) });
  if (ports.kept === undefined) throw new Error('the Windows group port is built from the keeper client, and none was given');
  return createJobGroupPort(ports.kept);
};

let hostPort: ProcessGroupPort | undefined;

export const hostProcessGroupPort = (): ProcessGroupPort => {
  hostPort ??= createProcessGroupPort(process.platform, { run: nodeCommandRunner, env: process.env, kept: hostKeptGroups() });
  return hostPort;
};

export const groupPortOf = (given: ProcessGroupPort | undefined, kill: SignalSender | undefined): ProcessGroupPort =>
  given ?? (kill === undefined ? hostProcessGroupPort() : createProcessGroupPort(process.platform, { run: nodeCommandRunner, env: process.env, kill, kept: hostKeptGroups() }));

export const hostSignalSender: SignalSender = (target, signal) => void process.kill(target, signal);

export type AsyncSignalSender = (target: number, signal: NodeJS.Signals | 0, options: GroupProbeOptions) => Promise<void>;

const noSuchProcess = (): NodeJS.ErrnoException => Object.assign(new Error('no such process group'), { code: 'ESRCH' });

export const createAsyncSignalSender = (platform: NodeJS.Platform, port: () => ProcessGroupPort): AsyncSignalSender => {
  if (platform !== 'win32') return async (target, signal) => void process.kill(target, signal);
  return async (target, signal, options) => {
    if (target >= 0) {
      process.kill(target, signal);
      return;
    }
    const group = port();
    if (signal === 0) {
      if (!(await group.alive(-target, options))) throw noSuchProcess();
      return;
    }
    await group.signal(-target, signal, options);
  };
};

export const hostAsyncSignalSender: AsyncSignalSender = createAsyncSignalSender(process.platform, hostProcessGroupPort);
