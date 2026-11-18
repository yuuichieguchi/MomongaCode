import { execFileSync } from '@momonga/testkit/child-process';
import fs from 'node:fs';
import path from 'node:path';

export type RunRoots = { readonly startedIn: string | undefined; readonly vitestRoot: string; readonly vitestRepository: string | undefined };

const NOT_A_REPOSITORY = 128;

export const repositoryRootOf = (directory: string): string | undefined => {
  try {
    return fs.realpathSync(execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim());
  } catch (error) {
    if ((error as { status?: unknown }).status === NOT_A_REPOSITORY) return undefined;
    throw error;
  }
};

export const runRootRefusalOf = ({ startedIn, vitestRoot, vitestRepository }: RunRoots): string | undefined => {
  if (startedIn !== undefined && vitestRepository !== undefined && startedIn !== vitestRepository)
    return `test run: started in the repository ${startedIn} but vitest runs the code of ${vitestRoot}; start the run from ${vitestRepository}, or run the vitest of ${startedIn}`;
  return undefined;
};

export const runRootsOf = (vitestRoot: string, cwd: string): RunRoots => {
  const resolved = fs.realpathSync(path.resolve(vitestRoot));
  return { startedIn: repositoryRootOf(cwd), vitestRoot: resolved, vitestRepository: repositoryRootOf(resolved) };
};
