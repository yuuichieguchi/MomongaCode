import { nodeSyncCommandRunner } from './command-runner.ts';
import type { SyncCommandRunner } from './command-runner.ts';
import type { SignalSender } from '../process-alive.ts';
import { createWindowsGroupControl } from './windows-inspector.ts';

export interface ProcessGroupPort {
  signal(pgid: number, signal: NodeJS.Signals): void;
  alive(pgid: number): boolean;
}

const tolerated = (error: unknown): 'gone' | 'denied' | 'other' => {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'ESRCH') return 'gone';
  if (code === 'EPERM') return 'denied';
  return 'other';
};

export const posixGroupPort: ProcessGroupPort = {
  signal: (pgid, signal) => {
    try {
      process.kill(-pgid, signal);
    } catch (error) {
      if (tolerated(error) === 'other') throw error;
    }
  },
  alive: (pgid) => {
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

export type GroupPortPorts = { run: SyncCommandRunner; env: Readonly<Record<string, string | undefined>> };

export const createProcessGroupPort = (platform: NodeJS.Platform, ports: GroupPortPorts): ProcessGroupPort => {
  if (platform !== 'win32') return posixGroupPort;
  const control = createWindowsGroupControl({ run: ports.run, env: ports.env });
  return {
    signal: (pgid) => control.terminate(pgid),
    alive: (pgid) => control.members(pgid).length > 0,
  };
};

let hostPort: ProcessGroupPort | undefined;

export const hostProcessGroupPort = (): ProcessGroupPort => {
  hostPort ??= createProcessGroupPort(process.platform, { run: nodeSyncCommandRunner, env: process.env });
  return hostPort;
};

const noSuchProcess = (): NodeJS.ErrnoException => Object.assign(new Error('no such process group'), { code: 'ESRCH' });

export const createSignalSender = (platform: NodeJS.Platform, port: () => ProcessGroupPort): SignalSender => {
  if (platform !== 'win32') return (target, signal) => void process.kill(target, signal);
  return (target, signal) => {
    if (target >= 0) {
      process.kill(target, signal);
      return;
    }
    const group = port();
    if (signal === 0) {
      if (!group.alive(-target)) throw noSuchProcess();
      return;
    }
    group.signal(-target, signal);
  };
};

export const hostSignalSender: SignalSender = createSignalSender(process.platform, hostProcessGroupPort);
