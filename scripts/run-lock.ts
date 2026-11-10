import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import type { RUN_LOCK_EXIT, RunClass } from './support/run-lock.ts';

const USAGE = 'usage: node scripts/run-lock.ts <heavy|light> [--wait <seconds>] -- <command> [args...]';
const COMMAND_SEPARATOR = '--';
const WAIT_OPTION = '--wait';
const COMMAND_NOT_STARTED_EXIT = 127;
const SIGNAL_EXIT_BASE = 128;
const SUPPORT_UNLOADABLE_EXIT: typeof RUN_LOCK_EXIT.unusable = 73;
const SUPPORT_DIR = path.join(import.meta.dirname, 'support');
const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const STOPPING_SIGNALS = ['SIGINT', 'SIGTERM'] as const;
const FORWARDED_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

type StoppingSignal = (typeof STOPPING_SIGNALS)[number];
type Environment = Readonly<Record<string, string | undefined>>;
type Invocation = { readonly runClass: RunClass; readonly waitOption: string | undefined; readonly command: string; readonly commandArgs: readonly string[] };
type CommandEnd = { readonly kind: 'ended'; readonly code: number | null; readonly signal: NodeJS.Signals | null } | { readonly kind: 'not-started'; readonly message: string };

const say = (line: string): void => {
  process.stderr.write(`${line}\n`);
};

const invocationOf = (argv: readonly string[]): Invocation | undefined => {
  const [runClass, ...rest] = argv;
  if (runClass !== 'heavy' && runClass !== 'light') return undefined;
  const waitOption = rest[0] === WAIT_OPTION ? rest[1] : undefined;
  const [separator, command, ...commandArgs] = rest[0] === WAIT_OPTION ? rest.slice(2) : rest;
  if (rest[0] === WAIT_OPTION && waitOption === undefined) return undefined;
  if (separator !== COMMAND_SEPARATOR || command === undefined) return undefined;
  return { runClass, waitOption, command, commandArgs };
};

const endOf = (command: string, commandArgs: readonly string[], env: Environment): Promise<CommandEnd> =>
  new Promise((resolve) => {
    const child = spawn(command, commandArgs, { stdio: 'inherit', env });
    const forwarders = FORWARDED_SIGNALS.map((signal) => {
      const forward = (): void => void child.kill(signal);
      process.on(signal, forward);
      return { signal, forward };
    });
    const settle = (end: CommandEnd): void => {
      for (const { signal, forward } of forwarders) process.off(signal, forward);
      resolve(end);
    };
    child.once('error', (error) => settle({ kind: 'not-started', message: error.message }));
    child.once('close', (code, signal) => settle({ kind: 'ended', code, signal }));
  });

const exitCodeOf = (end: Extract<CommandEnd, { kind: 'ended' }>): number => {
  if (end.signal !== null) return SIGNAL_EXIT_BASE + os.constants.signals[end.signal];
  if (end.code === null) throw new Error('the command ended with neither an exit code nor a signal');
  return end.code;
};

export const runUnderLock = async (argv: readonly string[], env: Environment): Promise<number> => {
  let lock: typeof import('./support/run-lock.ts');
  let devState: typeof import('./support/dev-state.ts');
  try {
    [lock, devState] = await Promise.all([import('./support/run-lock.ts'), import('./support/dev-state.ts')]);
  } catch (error) {
    const cause = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : error instanceof Error ? error.message : String(error);
    say(`run-lock: cannot use ${SUPPORT_DIR}: ${cause}`);
    return SUPPORT_UNLOADABLE_EXIT;
  }
  const { RUN_LOCK_ENV, RUN_LOCK_EXIT: EXIT, RUN_LOCK_WAIT_ENV, STOPPED_WHILE_WAITING_MESSAGE, acquireRunLock, causeOf, parseWaitSeconds, unusableMessage } = lock;

  const invocation = invocationOf(argv);
  if (invocation === undefined) {
    say(USAGE);
    return EXIT.usage;
  }
  const { runClass, waitOption, command, commandArgs } = invocation;

  let waitSeconds: number;
  try {
    waitSeconds = waitOption === undefined ? parseWaitSeconds(env[RUN_LOCK_WAIT_ENV], 'env') : parseWaitSeconds(waitOption, 'option');
  } catch (error) {
    say(causeOf(error));
    return EXIT.usage;
  }

  let stateDir: string;
  try {
    stateDir = devState.stateDirOf(REPO_ROOT, env);
  } catch (error) {
    say(unusableMessage(REPO_ROOT, causeOf(error)));
    return EXIT.unusable;
  }

  const stopping = new AbortController();
  let stoppedBy: StoppingSignal | undefined;
  const stoppers = STOPPING_SIGNALS.map((signal) => {
    const stop = (): void => {
      stoppedBy ??= signal;
      stopping.abort();
    };
    process.on(signal, stop);
    return { signal, stop };
  });
  const stopExitOf = (signal: StoppingSignal): number => (signal === 'SIGINT' ? EXIT.interrupted : EXIT.terminated);

  let outcome: Awaited<ReturnType<typeof acquireRunLock>>;
  try {
    outcome = await acquireRunLock({
      runClass,
      dir: path.join(stateDir, 'run-lock'),
      proofDir: path.join(stateDir, 'run-lock-proof'),
      command: [command, ...commandArgs].join(' '),
      cwd: process.cwd(),
      pid: process.pid,
      env,
      waitSeconds,
      signal: stopping.signal,
      say,
    });
  } finally {
    for (const { signal, stop } of stoppers) process.off(signal, stop);
  }

  if (outcome.kind === 'refused') {
    say(outcome.message);
    return EXIT.refused;
  }
  if (outcome.kind === 'waited-out') {
    say(outcome.message);
    return EXIT.waitedOut;
  }
  if (outcome.kind === 'unusable') {
    say(outcome.message);
    return EXIT.unusable;
  }
  const release = outcome.kind === 'acquired' ? outcome.release : async (): Promise<void> => undefined;
  if (stoppedBy !== undefined) {
    await release();
    say(STOPPED_WHILE_WAITING_MESSAGE);
    return stopExitOf(stoppedBy);
  }
  if (outcome.kind === 'aborted') throw new Error('the lock attempt was aborted without a stopping signal');

  let end: CommandEnd;
  try {
    end = await endOf(command, commandArgs, outcome.kind === 'acquired' ? { ...env, [RUN_LOCK_ENV]: outcome.token } : env);
  } finally {
    await release();
  }
  if (end.kind === 'not-started') {
    say(`run-lock: cannot start ${command}: ${end.message}`);
    return COMMAND_NOT_STARTED_EXIT;
  }
  return exitCodeOf(end);
};

if (import.meta.main) process.exitCode = await runUnderLock(process.argv.slice(2), process.env);
