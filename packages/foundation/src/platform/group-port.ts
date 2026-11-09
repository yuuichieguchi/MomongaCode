import { nodeCommandRunner } from './command-runner.ts';
import type { CommandRunner } from './command-runner.ts';
import type { SignalSender } from '../process-alive.ts';
import { createDarwinGroupStates } from './darwin-inspector.ts';
import { createLinuxGroupStates } from './linux-inspector.ts';
import { nodeProcFs } from './procfs.ts';
import type { ProcFs } from './procfs.ts';
import { canStillRun } from './run-state.ts';
import type { GroupStatesReader } from './run-state.ts';
import { UnsupportedPlatformError } from './process-inspector.ts';
import { createWindowsGroupControl } from './windows-inspector.ts';

export type GroupProbeOptions = { signal: AbortSignal | undefined };

export interface ProcessGroupPort {
  signal(pgid: number, signal: NodeJS.Signals, options: GroupProbeOptions): Promise<void>;
  alive(pgid: number, options: GroupProbeOptions): Promise<boolean>;
}

const tolerated = (error: unknown): 'gone' | 'denied' | 'other' => {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'ESRCH') return 'gone';
  if (code === 'EPERM') return 'denied';
  return 'other';
};

export const createPosixGroupPort = (states: GroupStatesReader): ProcessGroupPort => ({
  signal: async (pgid, signal) => {
    try {
      process.kill(-pgid, signal);
    } catch (error) {
      if (tolerated(error) === 'other') throw error;
    }
  },
  alive: async (pgid, options) => {
    try {
      process.kill(-pgid, 0);
      return true;
    } catch (error) {
      const verdict = tolerated(error);
      if (verdict === 'other') throw error;
      if (verdict === 'gone') return false;
      return (await states(pgid, options)).some(canStillRun);
    }
  },
});

export type GroupPortPorts = { run: CommandRunner; env: Readonly<Record<string, string | undefined>>; procfs?: ProcFs };

const unsupportedStates =
  (platform: NodeJS.Platform): GroupStatesReader =>
  async () => {
    throw new UnsupportedPlatformError(platform, 'reading the run states of a process group');
  };

const groupStatesOf = (platform: NodeJS.Platform, ports: GroupPortPorts): GroupStatesReader => {
  switch (platform) {
    case 'darwin':
      return createDarwinGroupStates(ports.run);
    case 'linux':
      return createLinuxGroupStates(ports.procfs ?? nodeProcFs);
    default:
      return unsupportedStates(platform);
  }
};

export const createProcessGroupPort = (platform: NodeJS.Platform, ports: GroupPortPorts): ProcessGroupPort => {
  if (platform !== 'win32') return createPosixGroupPort(groupStatesOf(platform, ports));
  const control = createWindowsGroupControl({ run: ports.run, env: ports.env });
  return {
    signal: (pgid, _signal, options) => control.terminate(pgid, options),
    alive: async (pgid, options) => (await control.members(pgid, options)).length > 0,
  };
};

let hostPort: ProcessGroupPort | undefined;

export const hostProcessGroupPort = (): ProcessGroupPort => {
  hostPort ??= createProcessGroupPort(process.platform, { run: nodeCommandRunner, env: process.env });
  return hostPort;
};

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
