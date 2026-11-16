import { spawn } from '@momonga/testkit/child-process';
import fs from 'node:fs';
import path from 'node:path';
import { registerE2eCleanup } from './home.ts';
import type { E2eHome } from './home.ts';
import { CLI_BUNDLE, CLI_FAKES_BUNDLE } from './cli-bundles.ts';
import { TEST_OPENER_RECORD_ENV, productTestEnv, readOpenerRecord } from '@momonga/testkit';
import type { OpenerCall } from '@momonga/testkit';
import { describeVerification } from '../../packages/cli/src/policy-messages.ts';
import { SESSION_PATH } from './runtime-client.ts';
import { baseSettings, sandboxChoiceOf, writeSettingsFile } from './stack.ts';
import { E2E_RUN_COMPLETED_BOUND_MS, withinBound } from './wait.ts';

export { CLI_BUNDLE, CLI_FAKES_BUNDLE, CLI_FAKES_ENTRY } from './cli-bundles.ts';

export const OPEN_LOG_FILE_NAME = 'opened-urls.log';
export const OPENER_RECORD_FILE_NAME = 'opened-by-stand-in.log';
export const SECRETS_FILE_NAME = 'fake-secrets.json';

export type CliResult = { readonly code: number | null; readonly signal: NodeJS.Signals | null; readonly stdout: string; readonly stderr: string };

export type RunCliOptions = { env?: Readonly<Record<string, string>>; cwd?: string; boundMs?: number; bundle?: string; executable?: string };

export const commandOf = (options: { bundle?: string; executable?: string }, args: readonly string[], defaultBundle: string): [string, string[]] =>
  options.executable !== undefined ? [options.executable, [...args]] : [process.execPath, [options.bundle ?? defaultBundle, ...args]];

export const cliEnv = (home: E2eHome, extra: Readonly<Record<string, string>> = {}): Record<string, string> =>
  productTestEnv({
    PATH: SESSION_PATH,
    HOME: home.home,
    TMPDIR: home.root,
    LANG: 'C',
    [TEST_OPENER_RECORD_ENV]: path.join(home.root, OPENER_RECORD_FILE_NAME),
    ...extra,
  });

export const openerCallsOf = (home: E2eHome): OpenerCall[] => readOpenerRecord(path.join(home.root, OPENER_RECORD_FILE_NAME));

export type RunningCli = { readonly result: Promise<CliResult>; readonly pid: number; kill(signal: NodeJS.Signals): void; interrupt(): void; partialStdout(): string; partialStderr(): string };

export const startCli = (home: E2eHome, args: readonly string[], options: RunCliOptions = {}): RunningCli => {
  const env = cliEnv(home, options.env);
  const [file, argv] = commandOf(options, args, CLI_BUNDLE);
  const child = spawn(file, argv, {
    cwd: options.cwd ?? home.project,
    env,
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
  const exited = new Promise<CliResult>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  const closed = exited.then(async (finished) => {
    try {
      await home.ledger.collect({});
    } catch (collectFailure) {
      throw new AggregateError([collectFailure], `momonga ${args.join(' ')} ended with code ${finished.code} and signal ${finished.signal}, and the ledger collection failed\nstderr:\n${finished.stderr}`, { cause: finished });
    }
    return finished;
  });
  registerE2eCleanup(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  });
  let awaitedResult: Promise<CliResult> | undefined;
  const awaitResult = (): Promise<CliResult> =>
    (awaitedResult ??= withinBound(closed, options.boundMs ?? E2E_RUN_COMPLETED_BOUND_MS, `momonga ${args.join(' ')}`).catch((error: unknown) => {
      throw new Error(`${error instanceof Error ? error.message : String(error)}\nstdout so far:\n${stdout}\nstderr so far:\n${stderr}`, { cause: error });
    }));
  if (child.pid === undefined) throw new Error(`momonga ${args.join(' ')} did not start`);
  return {
    get result() {
      return awaitResult();
    },
    pid: child.pid,
    kill: (signal) => void child.kill(signal),
    interrupt: () => void child.kill('SIGINT'),
    partialStdout: () => stdout,
    partialStderr: () => stderr,
  };
};

export const runCli = (home: E2eHome, args: readonly string[], options: RunCliOptions = {}): Promise<CliResult> => startCli(home, args, options).result;

const E2E_CHECK_COMMAND = 'echo verified';

export const E2E_DECLARED_CHECK = { commands: [E2E_CHECK_COMMAND] } as const;

export const E2E_CHECK_PASSED_TEXT = describeVerification({
  type: 'verification.completed',
  round: 1,
  conditionId: E2E_CHECK_COMMAND,
  command: E2E_CHECK_COMMAND,
  outcome: 'passed',
  durationMs: 0,
  output: '',
  mutationSeq: 0,
  id: 0,
  runId: '',
  sessionId: '',
  seq: 0,
  step: 0,
  createdAt: 0,
});

export const decideProjectFolderWithCheck = async (home: E2eHome): Promise<void> => {
  writeSettingsFile(home, { ...baseSettings(home, sandboxChoiceOf({ home }).kind), verification: E2E_DECLARED_CHECK, memory: { reflection: { enabled: false } } });
  const decided = await runCli(home, ['trust', home.project, '--set', 'trusted']);
  if (decided.code !== 0) throw new Error(`momonga trust ${home.project} --set trusted exited ${decided.code}: ${decided.stderr}`);
};

export const fakePortsEnv = (home: E2eHome): Record<string, string> => ({
  MOMONGA_E2E_OPEN_LOG: path.join(home.root, OPEN_LOG_FILE_NAME),
  MOMONGA_E2E_SECRETS_FILE: path.join(home.root, SECRETS_FILE_NAME),
});

export const CLI_VERSION_FILE_NAME = 'e2e-cli-version';

export const setFakeCliVersion = (home: E2eHome, version: string): void => {
  fs.writeFileSync(path.join(home.root, CLI_VERSION_FILE_NAME), version, { mode: 0o600 });
};

export const startCliWithFakes = (home: E2eHome, args: readonly string[], options: RunCliOptions = {}): RunningCli =>
  startCli(home, args, { ...options, bundle: CLI_FAKES_BUNDLE, env: { ...fakePortsEnv(home), ...options.env } });

export const runCliWithFakes = (home: E2eHome, args: readonly string[], options: RunCliOptions = {}): Promise<CliResult> => startCliWithFakes(home, args, options).result;

export const approveInBrowser = async (url: string): Promise<void> => {
  const authorize = await fetch(url, { redirect: 'manual' });
  const location = authorize.headers.get('location');
  if (location === null) throw new Error(`the authorization endpoint did not redirect (${authorize.status})`);
  await (await fetch(location)).arrayBuffer();
};
