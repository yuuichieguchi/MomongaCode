import path from 'node:path';
import { nodeFileSystem } from './node-file-system.ts';
import { nodeCommandRunner } from './platform/command-runner.ts';
import type { CommandResult, CommandRunner } from './platform/command-runner.ts';

export type GitConfigDiscovery = {
  workingDirectory: string;
  env: Readonly<Record<string, string>>;
  signal: AbortSignal;
  run?: CommandRunner;
  stat?: (file: string) => Promise<{ isFile(): boolean }>;
};

const NOT_A_REPOSITORY = /not a git repository/i;
const INCLUDE_PATHS = '^include(if\\..*)?\\.path$';

const lines = (text: string): string[] => text.split('\n').filter((line) => line !== '');

const originFile = (origin: string): string | undefined => (origin.startsWith('file:') ? origin.slice('file:'.length) : undefined);

const recordsOf = (text: string): Array<{ origin: string; entry: string }> => {
  const parts = text.split('\0');
  const records: Array<{ origin: string; entry: string }> = [];
  for (let index = 0; index + 1 < parts.length; index += 2) records.push({ origin: parts[index] as string, entry: parts[index + 1] as string });
  return records;
};

const errnoOf = (error: unknown): string | undefined => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
};

export const discoverGitConfigFiles = async (options: GitConfigDiscovery): Promise<string[]> => {
  const run = options.run ?? nodeCommandRunner;
  const stat = options.stat ?? ((file: string) => nodeFileSystem.stat(file));
  const git = async (args: readonly string[]): Promise<CommandResult | 'no-git'> => {
    try {
      return await run('git', ['-C', options.workingDirectory, ...args], { env: { ...options.env, GIT_TERMINAL_PROMPT: '0' }, signal: options.signal });
    } catch (error) {
      if (errnoOf(error) === 'ENOENT') return 'no-git';
      const cause = options.signal.aborted ? 'the call was cancelled or ran out of time' : error instanceof Error ? error.message : String(error);
      throw new Error(`git ${args.join(' ')} could not run to discover the git configuration files: ${cause}`);
    }
  };
  const found = new Set<string>();
  const add = (file: string): void => {
    found.add(path.resolve(options.workingDirectory, file));
  };
  for (const variable of ['GIT_CONFIG_SYSTEM', 'GIT_CONFIG_GLOBAL']) {
    const result = await git(['var', variable]);
    if (result === 'no-git') return [];
    if (result.exitCode === 0) for (const line of lines(result.stdout)) add(line);
    else if (result.stderr.trim() !== '') throw new Error(`git var ${variable} failed while discovering the git configuration files: ${result.stderr.trim()}`);
  }
  const repository = await git(['rev-parse', '--git-path', 'config', '--git-path', 'config.worktree']);
  if (repository === 'no-git') return [];
  if (repository.exitCode === 0) for (const line of lines(repository.stdout)) add(line);
  else if (!NOT_A_REPOSITORY.test(repository.stderr)) throw new Error(`git rev-parse failed while discovering the git configuration files: ${repository.stderr.trim()}`);
  const listed = await git(['config', '--list', '--show-origin', '-z']);
  if (listed === 'no-git') return [];
  if (listed.exitCode !== 0 && !NOT_A_REPOSITORY.test(listed.stderr)) throw new Error(`git config --list failed while discovering the git configuration files: ${listed.stderr.trim()}`);
  for (const { origin } of recordsOf(listed.stdout)) {
    const file = originFile(origin);
    if (file !== undefined) add(file);
  }
  const includes = await git(['config', '--get-regexp', '-z', '--show-origin', '--type=path', INCLUDE_PATHS]);
  if (includes === 'no-git') return [];
  if (includes.exitCode !== 0 && includes.exitCode !== 1) throw new Error(`git config --get-regexp failed while discovering the git configuration files: ${includes.stderr.trim()}`);
  for (const { origin, entry } of recordsOf(includes.stdout)) {
    const includer = originFile(origin);
    const target = entry.slice(entry.indexOf('\n') + 1);
    if (target === '') continue;
    add(path.isAbsolute(target) || includer === undefined ? target : path.join(path.dirname(path.resolve(options.workingDirectory, includer)), target));
  }
  const kept: string[] = [];
  for (const file of found) {
    try {
      if ((await stat(file)).isFile()) kept.push(file);
    } catch (error) {
      if (errnoOf(error) !== 'ENOENT') throw error;
      kept.push(file);
    }
  }
  return kept;
};
