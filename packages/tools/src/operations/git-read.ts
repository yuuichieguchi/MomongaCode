import { spawn } from 'node:child_process';
import { readOnlyEnvironment } from '../read-only-call.ts';
import { ToolExecutionError } from '../types.ts';

export type GitRead = { exitCode: number; stdout: string; stderr: string };

export type GitReadOptions = { cwd: string; env: Readonly<Record<string, string>>; signal: AbortSignal };

export type GitReader = (args: readonly string[], options: GitReadOptions) => Promise<GitRead>;

export const hostGitReader: GitReader = (args, { cwd, env, signal }) =>
  new Promise((resolve, reject) => {
    const child = spawn('git', [...args], { cwd, env: readOnlyEnvironment(env), stdio: ['ignore', 'pipe', 'pipe'], signal });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (error) => reject(signal.aborted ? new ToolExecutionError('the call was cancelled or ran out of time') : error));
    child.on('close', (code) => resolve({ exitCode: code ?? 1, stdout, stderr }));
  });

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

export const resolveDestinations = async (read: GitReader, remote: string, options: GitReadOptions): Promise<Destinations> => ({
  push: await urlsOf(read, remote, ['--push'], options),
  fetch: await urlsOf(read, remote, [], options),
});

export const sameList = (left: readonly unknown[], right: readonly unknown[]): boolean => left.length === right.length && left.every((value, index) => value === right[index]);
