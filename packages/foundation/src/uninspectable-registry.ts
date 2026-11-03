import { isProcessAlive } from './process-alive.ts';
import type { UninspectableProcess } from './platform/inspector-types.ts';

export type UninspectableRegistry = {
  firstNaming(context: string, process: UninspectableProcess): boolean;
  size(): number;
};

export type UninspectableRegistryPorts = { isAlive?: (pid: number) => boolean };

export const createUninspectableRegistry = ({ isAlive = (pid) => isProcessAlive(pid) }: UninspectableRegistryPorts = {}): UninspectableRegistry => {
  const named = new Map<string, UninspectableProcess>();
  const keyOf = (context: string, process: UninspectableProcess): string => `${context}\u0000${process.pid}\u0000${process.startTicks}`;

  const forget = (incoming: UninspectableProcess): void => {
    for (const [key, entry] of named) {
      const replaced = entry.pid === incoming.pid && entry.startTicks !== incoming.startTicks;
      if (replaced || !isAlive(entry.pid)) named.delete(key);
    }
  };

  return {
    firstNaming: (context, process) => {
      forget(process);
      const key = keyOf(context, process);
      if (named.has(key)) return false;
      named.set(key, process);
      return true;
    },
    size: () => named.size,
  };
};

export const defaultUninspectableRegistry: UninspectableRegistry = createUninspectableRegistry();
