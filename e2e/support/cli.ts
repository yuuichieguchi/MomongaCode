import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { registerE2eCleanup } from './home.ts';
import type { E2eHome } from './home.ts';
import { REPO_ROOT } from './launcher.ts';
import { SESSION_PATH } from './runtime-client.ts';
import { E2E_TEST_TIMEOUT_MS, withinBound } from './wait.ts';

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

export const trackDaemon = async (home: E2eHome): Promise<void> => {
  const lock = home.paths.locks.supervisor;
  if (!fs.existsSync(lock)) return;
  const pid = Number.parseInt(fs.readFileSync(lock, 'utf8'), 10);
  if (Number.isInteger(pid) && pid > 1) await home.ledger.add(pid, 'supervisor');
};

export type RunningCli = { readonly result: Promise<CliResult> };

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
  const result = withinBound(closed, options.boundMs ?? E2E_TEST_TIMEOUT_MS, `momonga ${args.join(' ')}`).finally(() => trackDaemon(home));
  return { result };
};

export const runCli = (home: E2eHome, args: readonly string[], options: RunCliOptions = {}): Promise<CliResult> => startCli(home, args, options).result;
