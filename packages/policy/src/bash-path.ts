import path from 'node:path';

export type ShellPorts = {
  isExecutable(file: string): boolean;
  env: Readonly<Record<string, string | undefined>>;
};

export type ShellHost = { platform: NodeJS.Platform; isExecutable(file: string): boolean };

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

const gitForWindowsBash = (ports: ShellPorts): string | undefined => {
  for (const directory of pathEntries(ports.env)) {
    const git = path.win32.join(directory, 'git.exe');
    if (!ports.isExecutable(git)) continue;
    let ancestor = directory;
    for (let level = 0; level < GIT_ANCESTOR_LEVELS; level += 1) {
      const bash = path.win32.join(ancestor, 'bin', 'bash.exe');
      if (ports.isExecutable(bash)) return bash;
      ancestor = path.win32.dirname(ancestor);
    }
  }
  return undefined;
};

export const resolveBashPath = (platform: NodeJS.Platform, ports: ShellPorts): string => {
  if (platform === 'darwin') return '/bin/bash';
  if (platform === 'win32') {
    const bash = gitForWindowsBash(ports);
    if (bash === undefined) throw new ShellNotFoundError('Bash needs Git for Windows: no bin\\bash.exe was found next to a git.exe on PATH; install Git for Windows and put git.exe on PATH');
    return bash;
  }
  const found = POSIX_BASH_CANDIDATES.find((candidate) => ports.isExecutable(candidate));
  if (found === undefined) throw new ShellNotFoundError(`Bash needs bash at ${POSIX_BASH_CANDIDATES.join(' or ')}; install bash`);
  return found;
};
