import { hostKernelLock, sweepLeftovers } from '@momonga/foundation';
import type { KernelLockMechanism, LeftoverFiles } from '@momonga/foundation';
import type { RuntimeStore } from '@momonga/store';
import { nodeRuntimeFiles } from './runtime-files.ts';
import type { RuntimeFiles } from './runtime-files.ts';

const SESSION_TMP_RETENTION_MS = 7 * 86_400_000;

const everyName = (): boolean => true;

const leftoverFilesOf = (files: RuntimeFiles): LeftoverFiles => ({
  readdir: (directory) => files.readdir(directory),
  rm: (entry) => files.rm(entry, { recursive: true }),
});

export const sweepSpawnTmp = async ({
  dir,
  onWarning,
  files = nodeRuntimeFiles,
  lock = hostKernelLock(),
}: {
  dir: string;
  onWarning(message: string): void;
  files?: RuntimeFiles;
  lock?: KernelLockMechanism;
}): Promise<void> => {
  await sweepLeftovers({ directories: [{ directory: dir, isLeftover: everyName }], lock, files: leftoverFilesOf(files), warn: onWarning });
};

export const sweepSessionTmp = async ({
  root,
  store,
  now,
  hasInMemoryState,
  onWarning,
  files = nodeRuntimeFiles,
  lock = hostKernelLock(),
}: {
  root: string;
  store: Pick<RuntimeStore, 'sessionActivity'>;
  now: number;
  hasInMemoryState(sessionId: string): boolean;
  onWarning(message: string): void;
  files?: RuntimeFiles;
  lock?: KernelLockMechanism;
}): Promise<{ removed: number; kept: number }> => {
  const retained = (sessionId: string): boolean => {
    if (hasInMemoryState(sessionId)) return true;
    const activity = store.sessionActivity(sessionId);
    return activity !== undefined && (activity.hasActiveRun || now - activity.lastActivityAt < SESSION_TMP_RETENTION_MS);
  };
  const swept = await sweepLeftovers({
    directories: [{ directory: root, isLeftover: everyName, retain: retained }],
    lock,
    files: leftoverFilesOf(files),
    warn: onWarning,
  });
  return { removed: swept.removed.length, kept: swept.kept.length };
};
