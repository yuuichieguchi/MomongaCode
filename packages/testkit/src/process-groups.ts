import { forceKillGroup, inspectProcessLock, isProcessAlive, momongaLayout } from '@momonga/foundation';

const CLEANUP_KILL_DEADLINE_MS = 5000;
const HOLDER_EXIT_POLL_MS = 20;

const isMissingProcess = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ESRCH';

export const stopSupervisorHolder = async (home: string): Promise<number | undefined> => {
  const lockPath = momongaLayout(home).locks.supervisor;
  const lock = await inspectProcessLock(lockPath);
  if (lock.state === 'free') return undefined;
  if (lock.state === 'unreadable') throw new Error(`the supervisor lock ${lockPath} is held by a process that cannot be identified`);
  const { pid } = lock;
  if (pid === process.pid) return undefined;
  if (!Number.isInteger(pid) || pid <= 1) throw new Error(`refusing to kill pid ${pid} named by ${lockPath}`);
  await killGroupsForCleanup([pid]);
  try {
    process.kill(pid, 'SIGKILL');
  } catch (error) {
    if (!isMissingProcess(error)) throw error;
  }
  const deadline = Date.now() + CLEANUP_KILL_DEADLINE_MS;
  while (isProcessAlive(pid) || (await inspectProcessLock(lockPath)).state !== 'free') {
    if (Date.now() >= deadline) throw new Error(`the supervisor ${pid} holding ${lockPath} did not exit within ${CLEANUP_KILL_DEADLINE_MS} ms of SIGKILL`);
    await new Promise<void>((resolve) => setTimeout(resolve, HOLDER_EXIT_POLL_MS));
  }
  return pid;
};

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
