import { forceKillGroup } from '@momonga/foundation';

const CLEANUP_KILL_DEADLINE_MS = 5000;

export const killGroupsForCleanup = async (pgids: readonly number[]): Promise<void> => {
  const deadline = Date.now() + CLEANUP_KILL_DEADLINE_MS;
  const gone = await Promise.all(pgids.map((pgid) => forceKillGroup(pgid, { deadline })));
  const survivors = pgids.filter((_, index) => !gone[index]);
  if (survivors.length > 0) throw new Error(`cleanup could not kill process groups ${survivors.join(', ')}`);
};

export const killPidsForCleanup = (pids: Iterable<number>): void => {
  for (const pid of pids) {
    if (!Number.isInteger(pid) || pid <= 1) throw new Error(`refusing to kill pid ${pid}`);
    try {
      process.kill(pid, 'SIGKILL');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ESRCH' && code !== 'EPERM') throw error;
    }
  }
};
