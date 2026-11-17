import { createPosixGroupPort } from '@momonga/foundation';
import type { ProcessGroupPort } from '@momonga/foundation';

export const fakeGroupPort = (kill: (pid: number, signal: NodeJS.Signals | number) => void): ProcessGroupPort =>
  createPosixGroupPort({
    kill,
    reading: {
      successMeansRunnable: true,
      states: async (pgid) => {
        throw new Error(`the fake process table reads no run states (group ${pgid})`);
      },
    },
  });
