import { execFileSync } from '@momonga/testkit/child-process';
import { LSOF_PATH, pollUntil as pollOf } from '@momonga/testkit';

export const pollUntil = (predicate: () => boolean | Promise<boolean>, timeoutMs: number, description: string): Promise<void> => pollOf(predicate, { description, boundMs: timeoutMs });

export const lsofHolders = (file: string): number[] => {
  try {
    return execFileSync(LSOF_PATH, ['-t', '--', file], { encoding: 'utf8' })
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
    return execFileSync(LSOF_PATH, ['-p', String(pid), '-Fn'], { encoding: 'utf8' })
      .split('\n')
      .filter((line) => line.startsWith('n'))
      .map((line) => line.slice(1));
  } catch (error) {
    if ((error as { status?: number }).status === 1) return [];
    throw error;
  }
};

export const lsofAccess = (pid: number, fd: number): string | undefined => {
  const output = execFileSync(LSOF_PATH, ['-p', String(pid), '-a', '-d', String(fd), '-Ffa'], { encoding: 'utf8' });
  return output
    .split('\n')
    .find((line) => line.startsWith('a'))
    ?.slice(1);
};

export const processGroupOf = (pid: number): number => Number(execFileSync('/bin/ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' }).trim());
