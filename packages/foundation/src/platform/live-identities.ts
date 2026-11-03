import { isProcessAlive } from '../process-alive.ts';

export type LiveIdentities = {
  has(scope: string, pid: number, startTicks: string): boolean;
  add(scope: string, pid: number, startTicks: string): boolean;
  size(): number;
};

export type LiveIdentitiesPorts = { isAlive?: (pid: number) => boolean };

type Entry = { pid: number; startTicks: string };

export const createLiveIdentities = ({ isAlive = (pid) => isProcessAlive(pid) }: LiveIdentitiesPorts = {}): LiveIdentities => {
  const entries = new Map<string, Entry>();

  const prune = (pid: number, startTicks: string): void => {
    for (const [key, entry] of entries) {
      const replaced = entry.pid === pid && entry.startTicks !== startTicks;
      if (replaced || !isAlive(entry.pid)) entries.delete(key);
    }
  };
  const keyOf = (scope: string, pid: number, startTicks: string): string => `${scope}\u0000${pid}\u0000${startTicks}`;

  return {
    has: (scope, pid, startTicks) => {
      prune(pid, startTicks);
      return entries.has(keyOf(scope, pid, startTicks));
    },
    add: (scope, pid, startTicks) => {
      prune(pid, startTicks);
      const key = keyOf(scope, pid, startTicks);
      if (entries.has(key)) return false;
      entries.set(key, { pid, startTicks });
      return true;
    },
    size: () => entries.size,
  };
};
