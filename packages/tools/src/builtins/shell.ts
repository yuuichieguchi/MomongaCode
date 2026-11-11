import path from 'node:path';
import type { Awaitable, FileSystem, FileSystemSync } from '@momonga/foundation';
import type { ChildPorts } from '../ports.ts';

export type ExecutableCheck = (file: string) => Awaitable<boolean>;

export type ShellPorts = {
  isExecutable: ExecutableCheck;
  env: Readonly<Record<string, string | undefined>>;
};

export type ShellHost = { platform: NodeJS.Platform; isExecutable: ExecutableCheck; child: ChildPorts };

export type ShellPortsNow = { isExecutable(file: string): boolean; env: ShellPorts['env'] };

const absentOrThrown = (error: unknown): false => {
  if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
  throw error;
};

export const executableCheckOn =
  (files: Pick<FileSystem, 'access' | 'stat'>): ExecutableCheck =>
  async (file) => {
    try {
      await files.access(file, 'execute');
      return (await files.stat(file)).isFile();
    } catch (error) {
      return absentOrThrown(error);
    }
  };

export const executableCheckNowOn =
  (files: Pick<FileSystemSync, 'accessSync' | 'statSync'>): ShellPortsNow['isExecutable'] =>
  (file) => {
    try {
      files.accessSync(file, 'execute');
      return files.statSync(file).isFile();
    } catch (error) {
      return absentOrThrown(error);
    }
  };

export class ShellNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShellNotFoundError';
  }
}

const POSIX_BASH_CANDIDATES = ['/bin/bash', '/usr/bin/bash'] as const;
const GIT_ANCESTOR_LEVELS = 3;

const pathEntries = (env: ShellPorts['env']): string[] => {
  const raw = Object.entries(env).find(([name]) => name.toLowerCase() === 'path')?.[1];
  return raw === undefined ? [] : raw.split(';').filter((entry) => entry !== '');
};

function* bashPathAsking(platform: NodeJS.Platform, env: ShellPorts['env']): Generator<string, string, boolean> {
  if (platform === 'darwin') return '/bin/bash';
  if (platform === 'win32') {
    for (const directory of pathEntries(env)) {
      if (!(yield path.win32.join(directory, 'git.exe'))) continue;
      let ancestor = directory;
      for (let level = 0; level < GIT_ANCESTOR_LEVELS; level += 1) {
        const bash = path.win32.join(ancestor, 'bin', 'bash.exe');
        if (yield bash) return bash;
        ancestor = path.win32.dirname(ancestor);
      }
    }
    throw new ShellNotFoundError('Bash needs Git for Windows: no bin\\bash.exe was found next to a git.exe on PATH; install Git for Windows and put git.exe on PATH');
  }
  for (const candidate of POSIX_BASH_CANDIDATES) if (yield candidate) return candidate;
  throw new ShellNotFoundError(`Bash needs bash at ${POSIX_BASH_CANDIDATES.join(' or ')}; install bash`);
}

export const resolveBashPath = async (platform: NodeJS.Platform, ports: ShellPorts): Promise<string> => {
  const asking = bashPathAsking(platform, ports.env);
  let turn = asking.next();
  while (turn.done !== true) turn = asking.next(await ports.isExecutable(turn.value));
  return turn.value;
};

export const resolveBashPathNow = (platform: NodeJS.Platform, ports: ShellPortsNow): string => {
  const asking = bashPathAsking(platform, ports.env);
  let turn = asking.next();
  while (turn.done !== true) turn = asking.next(ports.isExecutable(turn.value));
  return turn.value;
};
