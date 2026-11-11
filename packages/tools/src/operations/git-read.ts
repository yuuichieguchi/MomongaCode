import { WORDS } from '@momonga/protocol';
import { gitEnvironment } from '../read-only-call.ts';
import { ToolExecutionError } from '../types.ts';
import type { ProbeContext } from '../types.ts';
import type { ArgvResult, ArgvRunner } from './argv.ts';

export type GitRead = ArgvResult;

export type GitReadOptions = { cwd: string; env: Readonly<Record<string, string>>; signal: AbortSignal; context: ProbeContext };

export type GitReader = (args: readonly string[], options: GitReadOptions) => Promise<GitRead>;

export const createGitReader =
  (runArgv: ArgvRunner): GitReader =>
  (args, { cwd, env, signal, context }) =>
    runArgv(['git', ...args], { cwd, env: gitEnvironment(env, { mode: 'read' }), signal, network: 'none', context, effect: false });

export type Destinations = { push: string[]; fetch: string[] };

const urlsOf = async (read: GitReader, remote: string, direction: readonly string[], options: GitReadOptions): Promise<string[]> => {
  let result: GitRead;
  try {
    result = await read(['remote', 'get-url', ...direction, '--all', remote], options);
  } catch (error) {
    throw new ToolExecutionError(`the destinations of remote ${remote} could not be resolved: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (result.exitCode !== 0) throw new ToolExecutionError(`the destinations of remote ${remote} could not be resolved: ${result.stderr.trim()}`);
  return result.stdout
    .trim()
    .split('\n')
    .filter((line) => line !== '');
};

export const resolveRepository = async (read: GitReader, options: GitReadOptions): Promise<string> => {
  const result = await read(['rev-parse', '--show-toplevel'], options);
  const top = result.stdout.replace(/\r?\n$/, '');
  if (result.exitCode !== 0 || top === '') throw new ToolExecutionError(`the ${WORDS.folder} ${options.cwd} is not inside a git repository, so there is no repository to act on`);
  return top;
};

export const resolveDestinations = async (read: GitReader, remote: string, options: GitReadOptions): Promise<Destinations> => ({
  push: await urlsOf(read, remote, ['--push'], options),
  fetch: await urlsOf(read, remote, [], options),
});

export const sameList = (left: readonly unknown[], right: readonly unknown[]): boolean => left.length === right.length && left.every((value, index) => value === right[index]);

const REPOSITORY_SCOPES: readonly string[] = ['local', 'worktree'];

export type RepositoryKey = { scope: string; key: string };

export const repositoryOwnKeys = async (read: GitReader, options: GitReadOptions): Promise<RepositoryKey[]> => {
  const result = await read(['config', '--list', '--show-scope', '--name-only', '-z'], options);
  if (result.exitCode !== 0) throw new ToolExecutionError(`the configuration of the repository could not be read: ${result.stderr.trim()}`);
  const fields = result.stdout.split('\0');
  const keys = new Map<string, RepositoryKey>();
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const scope = fields[index];
    const key = fields[index + 1];
    if (scope !== undefined && key !== undefined && REPOSITORY_SCOPES.includes(scope)) keys.set(`${scope} ${key}`, { scope, key });
  }
  return [...keys.values()];
};
