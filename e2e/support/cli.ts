import { spawn } from 'node:child_process';
import path from 'node:path';
import { registerE2eCleanup } from './home.ts';
import type { E2eHome } from './home.ts';
import { REPO_ROOT } from './launcher.ts';
import { SESSION_PATH } from './runtime-client.ts';
import { E2E_RUN_COMPLETED_BOUND_MS, withinBound } from './wait.ts';

export const CLI_BUNDLE = path.join(REPO_ROOT, 'packages', 'cli', 'dist', 'main.js');

export type CliResult = { readonly code: number | null; readonly signal: NodeJS.Signals | null; readonly stdout: string; readonly stderr: string };

export type RunCliOptions = { env?: Readonly<Record<string, string>>; cwd?: string; boundMs?: number };

export const cliEnv = (home: E2eHome, extra: Readonly<Record<string, string>> = {}): Record<string, string> => ({
  PATH: SESSION_PATH,
  HOME: home.home,
  TMPDIR: home.root,
  LANG: 'C',
  ...extra,
});

export type RunningCli = { readonly result: Promise<CliResult>; interrupt(): void };

export const startCli = (home: E2eHome, args: readonly string[], options: RunCliOptions = {}): RunningCli => {
  const child = spawn(process.execPath, [CLI_BUNDLE, ...args], {
    cwd: options.cwd ?? home.project,
    env: cliEnv(home, options.env),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    stderr += chunk;
  });
  const closed = new Promise<CliResult>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  registerE2eCleanup(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  });
  const result = withinBound(closed, options.boundMs ?? E2E_RUN_COMPLETED_BOUND_MS, `momonga ${args.join(' ')}`).catch((error: unknown) => {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\nstdout so far:\n${stdout}\nstderr so far:\n${stderr}`, { cause: error });
  });
  return { result, interrupt: () => void child.kill('SIGINT') };
};

export const runCli = (home: E2eHome, args: readonly string[], options: RunCliOptions = {}): Promise<CliResult> => startCli(home, args, options).result;
