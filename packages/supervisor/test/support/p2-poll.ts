import { execFileSync } from 'node:child_process';

export const pollUntil = async (predicate: () => boolean | Promise<boolean>, timeoutMs: number, description: string): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error(`pollUntil: ${description} not met within ${timeoutMs} ms`);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
};

export const lsofHolders = (file: string): number[] => {
  try {
    return execFileSync('/usr/sbin/lsof', ['-t', '--', file], { encoding: 'utf8' })
      .split('\n')
      .filter((line) => line.length > 0)
      .map(Number)
      .sort((a, b) => a - b);
  } catch (error) {
    if ((error as { status?: number }).status === 1) return [];
    throw error;
  }
};

export const lsofNames = (pid: number): string[] => {
  try {
    return execFileSync('/usr/sbin/lsof', ['-p', String(pid), '-Fn'], { encoding: 'utf8' })
      .split('\n')
      .filter((line) => line.startsWith('n'))
      .map((line) => line.slice(1));
  } catch (error) {
    if ((error as { status?: number }).status === 1) return [];
    throw error;
  }
};

export const lsofAccess = (pid: number, fd: number): string | undefined => {
  const output = execFileSync('/usr/sbin/lsof', ['-p', String(pid), '-a', '-d', String(fd), '-Ffa'], { encoding: 'utf8' });
  return output
    .split('\n')
    .find((line) => line.startsWith('a'))
    ?.slice(1);
};

export const processGroupOf = (pid: number): number => Number(execFileSync('/bin/ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' }).trim());
