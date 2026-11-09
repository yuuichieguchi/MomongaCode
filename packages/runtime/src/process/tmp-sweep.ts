import type fs from 'node:fs';
import path from 'node:path';
import { uuidv7 } from '@momonga/foundation';
import type { RuntimeStore } from '@momonga/store';
import { asError } from './as-error.ts';
import { nodeRuntimeFiles } from './runtime-files.ts';
import type { RuntimeFiles } from './runtime-files.ts';

const SESSION_TMP_MAX_AGE_MS = 7 * 86_400_000;
const REMOVING_PREFIX = '.removing-';

const isMissing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT';

const readNames = async (files: RuntimeFiles, dir: string, onWarning: (message: string) => void): Promise<string[]> => {
  try {
    return await files.readdir(dir);
  } catch (error) {
    if (!isMissing(error)) onWarning(`tmp directory ${dir} could not be read: ${asError(error).message}`);
    return [];
  }
};

const removeEntry = async (files: RuntimeFiles, entry: string, stat: fs.Stats): Promise<void> => {
  if (stat.isDirectory()) await files.rm(entry, { recursive: true });
  else await files.unlink(entry);
};

export const sweepSpawnTmp = async ({
  dir,
  onWarning,
  files = nodeRuntimeFiles,
}: {
  dir: string;
  onWarning(message: string): void;
  files?: RuntimeFiles;
}): Promise<void> => {
  for (const name of await readNames(files, dir, onWarning)) {
    const entry = path.join(dir, name);
    try {
      await removeEntry(files, entry, await files.lstat(entry));
    } catch (error) {
      if (!isMissing(error)) onWarning(`spawn tmp entry ${entry} could not be removed: ${asError(error).message}`);
    }
  }
};

export const sweepSessionTmp = async ({
  root,
  store,
  now,
  hasInMemoryState,
  onWarning,
  files = nodeRuntimeFiles,
}: {
  root: string;
  store: Pick<RuntimeStore, 'sessionActivity'>;
  now: number;
  hasInMemoryState(sessionId: string): boolean;
  onWarning(message: string): void;
  files?: RuntimeFiles;
}): Promise<{ removed: number; kept: number }> => {
  const removable = (id: string): boolean => {
    if (hasInMemoryState(id)) return false;
    const activity = store.sessionActivity(id);
    return activity === undefined || (!activity.hasActiveRun && now - activity.lastActivityAt >= SESSION_TMP_MAX_AGE_MS);
  };

  let removed = 0;
  let kept = 0;
  for (const name of await readNames(files, root, onWarning)) {
    if (!removable(name)) {
      kept += 1;
      continue;
    }
    const entry = path.join(root, name);
    try {
      await files.lstat(entry);
    } catch (error) {
      if (!isMissing(error)) {
        onWarning(`session tmp entry ${entry} could not be inspected: ${asError(error).message}`);
        kept += 1;
      }
      continue;
    }

    let target: { path: string; stat: fs.Stats } | 'unlinked' | 'gone' | 'kept';
    if (!removable(name)) target = 'kept';
    else {
      try {
        const current = files.lstatSync(entry);
        if (!current.isDirectory()) {
          files.unlinkSync(entry);
          target = 'unlinked';
        } else if (name.startsWith(REMOVING_PREFIX)) target = { path: entry, stat: current };
        else {
          const renamed = path.join(root, `${REMOVING_PREFIX}${uuidv7()}`);
          files.renameSync(entry, renamed);
          target = { path: renamed, stat: current };
        }
      } catch (error) {
        if (isMissing(error)) target = 'gone';
        else {
          onWarning(`session tmp entry ${entry} could not be removed: ${asError(error).message}`);
          kept += 1;
          continue;
        }
      }
    }

    if (target === 'kept') kept += 1;
    else if (target === 'unlinked') removed += 1;
    else if (target !== 'gone') {
      try {
        await removeEntry(files, target.path, target.stat);
        removed += 1;
      } catch (error) {
        onWarning(`session tmp entry ${target.path} could not be removed: ${asError(error).message}`);
        kept += 1;
      }
    }
  }
  return { removed, kept };
};
