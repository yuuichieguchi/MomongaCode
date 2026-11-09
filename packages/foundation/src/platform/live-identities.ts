import { isProcessAlive } from '../process-alive.ts';

export type LiveIdentities = {
  has(scope: string, pid: number, startedAt: number): boolean;
  add(scope: string, pid: number, startedAt: number): boolean;
  size(): number;
};

export type LiveIdentitiesPorts = { isAlive?: (pid: number) => boolean };

type Entry = { pid: number; startedAt: number };

export const createLiveIdentities = ({ isAlive = (pid) => isProcessAlive(pid) }: LiveIdentitiesPorts = {}): LiveIdentities => {
  const entries = new Map<string, Entry>();

  const prune = (pid: number, startedAt: number): void => {
    for (const [key, entry] of entries) {
      const replaced = entry.pid === pid && entry.startedAt !== startedAt;
      if (replaced || !isAlive(entry.pid)) entries.delete(key);
    }
  };
  const keyOf = (scope: string, pid: number, startedAt: number): string => `${scope}\u0000${pid}\u0000${startedAt}`;

  return {
    has: (scope, pid, startedAt) => {
      prune(pid, startedAt);
      return entries.has(keyOf(scope, pid, startedAt));
    },
    add: (scope, pid, startedAt) => {
      prune(pid, startedAt);
      const key = keyOf(scope, pid, startedAt);
      if (entries.has(key)) return false;
      entries.set(key, { pid, startedAt });
      return true;
    },
    size: () => entries.size,
  };
};
