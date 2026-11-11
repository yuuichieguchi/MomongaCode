import { Duplex, Readable } from 'node:stream';
import { CONTROL_PLANE_LAUNCH, DAEMON_MARKER_FD, LIFELINE_FD, launchGroupLeader, signalGroup } from '@momonga/foundation';
import type { GroupLaunchMarker, GroupLaunchRequest, ProcessGroupPort } from '@momonga/foundation';
import type { ChildExit, ChildHandle, SpawnPort } from './child-manager.ts';

const endedReadable = (): Readable => Readable.from([]);

export type SpawnPortHost = { platform?: NodeJS.Platform; port?: ProcessGroupPort; spawnProcess?: GroupLaunchRequest['spawnProcess'] };

export const createSpawnPort = ({ platform = process.platform, port, spawnProcess }: SpawnPortHost = {}): SpawnPort => (command, args, options) => {
  const descriptor = options.stdio[DAEMON_MARKER_FD];
  const marker: GroupLaunchMarker = options.markerFile === undefined ? { slot: DAEMON_MARKER_FD, descriptor } : { slot: DAEMON_MARKER_FD, file: options.markerFile, descriptor };
  const launched = launchGroupLeader({
    file: command,
    args,
    cwd: options.cwd,
    env: options.env,
    stdio: options.stdio,
    marker,
    protection: CONTROL_PLANE_LAUNCH,
    ...(port === undefined ? {} : { port }),
    ...(spawnProcess === undefined ? {} : { spawnProcess }),
  });
  const { child, pgid } = launched;
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
  launched.onExit((exit) => {
    for (const listener of exitListeners) listener(exit);
  }, deliverError);
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
    onCommandPid: (listener) => {
      launched.onStart(listener);
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
      if (pgid === undefined) throw new Error(`cannot signal the group of ${command}: the process was never spawned`);
      await signalGroup(pgid, 'SIGKILL', undefined, stop);
    },
  };
  return handle;
};
