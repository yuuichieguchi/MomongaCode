import fs from 'node:fs';
import path from 'node:path';

export const STATE_DIR_ENV = 'MOMONGA_DEV_STATE_DIR';

export class DevStateError extends Error {}

const STATE_DIR_NAME = 'momonga-dev';
const GITDIR_PREFIX = 'gitdir: ';

const isMissing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT';

const firstLineOf = (text: string): string => (text.split('\n')[0] as string).replace(/\r$/, '');

const statOrMissing = (file: string): fs.Stats | undefined => {
  try {
    return fs.statSync(file);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
};

const textOrMissing = (file: string): string | undefined => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
};

const commonDirOf = (repoRoot: string, gitEntry: string): string => {
  const line = firstLineOf(fs.readFileSync(gitEntry, 'utf8'));
  const named = line.startsWith(GITDIR_PREFIX) ? line.slice(GITDIR_PREFIX.length).trim() : '';
  if (named.length === 0) throw new DevStateError(`${gitEntry} is neither a git directory nor a gitdir file`);
  const gitDir = path.resolve(repoRoot, named);
  const commonDir = textOrMissing(path.join(gitDir, 'commondir'));
  return commonDir === undefined ? gitDir : path.resolve(gitDir, firstLineOf(commonDir).trim());
};

export const stateDirOf = (repoRoot: string, env: Readonly<Record<string, string | undefined>>): string => {
  const given = env[STATE_DIR_ENV];
  if (given !== undefined && given.length > 0) {
    if (!path.isAbsolute(given)) throw new DevStateError(`${STATE_DIR_ENV} must be an absolute path, got "${given}"`);
    return path.resolve(given);
  }
  const gitEntry = path.join(repoRoot, '.git');
  const stat = statOrMissing(gitEntry);
  if (stat === undefined) return path.join(repoRoot, '.cache', STATE_DIR_NAME);
  return path.join(stat.isDirectory() ? gitEntry : commonDirOf(repoRoot, gitEntry), STATE_DIR_NAME);
};
