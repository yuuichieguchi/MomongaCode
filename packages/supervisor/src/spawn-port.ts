import { spawn } from 'node:child_process';
import { Duplex, Readable } from 'node:stream';
import { LIFELINE_FD, signalGroup } from '@momonga/foundation';
import type { ChildExit, ChildHandle, SpawnPort } from './child-manager.ts';

const endedReadable = (): Readable => Readable.from([]);

export const createSpawnPort = (platform: NodeJS.Platform = process.platform): SpawnPort => (command, args, options) => {
  const child = spawn(command, [...args], { cwd: options.cwd, env: { ...options.env }, detached: options.detached, windowsHide: true, stdio: [...options.stdio] });
  const errorListeners: ((error: NodeJS.ErrnoException) => void)[] = [];
  const exitListeners: ((exit: ChildExit) => void)[] = [];
  const deliverError = (error: NodeJS.ErrnoException): void => {
    for (const listener of errorListeners) listener(error);
  };
  const stdout = child.stdout ?? endedReadable();
  const stderr = child.stderr ?? endedReadable();
  const lifelineStream = child.stdio[LIFELINE_FD];
  const lifeline = lifelineStream instanceof Duplex ? lifelineStream : null;
  child.on('error', deliverError);
  stdout.on('error', deliverError);
  stderr.on('error', deliverError);
  lifeline?.on('error', deliverError);
  child.on('exit', (code, signal) => {
    for (const listener of exitListeners) listener({ code, signal });
  });
  const handle: ChildHandle = {
    pid: child.pid,
    stdout,
    stderr,
    lifeline,
    onSpawnError: (listener) => {
      errorListeners.push(listener);
    },
    onExit: (listener) => {
      exitListeners.push(listener);
    },
    kill: (signal) => {
      if (platform === 'win32') {
        if (lifeline === null) throw new Error(`cannot stop ${command}: it has no lifeline and signals terminate a Windows process without a graceful close`);
        lifeline.destroy();
        return;
      }
      child.kill(signal);
    },
    killGroup: async (stop) => {
      if (child.pid === undefined) throw new Error(`cannot signal the group of ${command}: the process was never spawned`);
      await signalGroup(child.pid, 'SIGKILL', undefined, stop);
    },
  };
  return handle;
};
