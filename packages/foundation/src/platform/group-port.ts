import { nodeCommandRunner } from './command-runner.ts';
import type { CommandRunner } from './command-runner.ts';
import type { SignalSender } from '../process-alive.ts';
import type { ProbeOptions } from './inspector-types.ts';
import { createWindowsGroupControl } from './windows-inspector.ts';

export interface ProcessGroupPort {
  signal(pgid: number, signal: NodeJS.Signals, options: ProbeOptions): Promise<void>;
  alive(pgid: number, options: ProbeOptions): Promise<boolean>;
}

const tolerated = (error: unknown): 'gone' | 'denied' | 'other' => {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'ESRCH') return 'gone';
  if (code === 'EPERM') return 'denied';
  return 'other';
};

export const posixGroupPort: ProcessGroupPort = {
  signal: async (pgid, signal) => {
    try {
      process.kill(-pgid, signal);
    } catch (error) {
      if (tolerated(error) === 'other') throw error;
    }
  },
  alive: async (pgid) => {
    try {
      process.kill(-pgid, 0);
      return true;
    } catch (error) {
      const verdict = tolerated(error);
      if (verdict === 'other') throw error;
      return verdict === 'denied';
    }
  },
};

export type GroupPortPorts = { run: CommandRunner; env: Readonly<Record<string, string | undefined>> };

export const createProcessGroupPort = (platform: NodeJS.Platform, ports: GroupPortPorts): ProcessGroupPort => {
  if (platform !== 'win32') return posixGroupPort;
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

export type AsyncSignalSender = (target: number, signal: NodeJS.Signals | 0, options: ProbeOptions) => Promise<void>;

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
