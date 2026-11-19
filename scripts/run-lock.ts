import os from 'node:os';
import path from 'node:path';
import type { BudgetBreach } from './support/cpu-budget.ts';
import type { RUN_LOCK_EXIT, RunClass, StoppingSignal } from './support/run-lock.ts';

const USAGE = [
  'usage: node scripts/run-lock.ts <heavy|light> --budget-cpu-seconds <seconds> [--wait <seconds>] -- <command> [args...]',
  'The command runs in its own process group. The group is ended, and the lock freed, when the CPU time of the command and every process under it passes the budget, when this process is stopped by a signal, or when the process that started this one is gone.',
].join('\n');
const COMMAND_SEPARATOR = '--';
const WAIT_OPTION = '--wait';
const BUDGET_OPTION = '--budget-cpu-seconds';
const COMMAND_NOT_STARTED_EXIT = 127;
const SIGNAL_EXIT_BASE = 128;
const SUPPORT_UNLOADABLE_EXIT: typeof RUN_LOCK_EXIT.unusable = 73;
const SUPPORT_DIR = path.join(import.meta.dirname, 'support');
const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const FORWARDED_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

type Environment = Readonly<Record<string, string | undefined>>;
type Invocation = { readonly runClass: RunClass; readonly waitOption: string | undefined; readonly budgetOption: string; readonly command: string; readonly commandArgs: readonly string[] };
type CommandEnd = { readonly kind: 'ended'; readonly code: number | null; readonly signal: NodeJS.Signals | null; readonly breach: BudgetBreach | undefined; readonly usedCpuSeconds: number } | { readonly kind: 'not-started'; readonly message: string };

const say = (line: string): void => {
  process.stderr.write(`${line}\n`);
};

const invocationOf = (argv: readonly string[]): Invocation | undefined => {
  const [runClass, ...rest] = argv;
  if (runClass !== 'heavy' && runClass !== 'light') return undefined;
  const options = new Map<string, string>();
  let index = 0;
  while (rest[index] === WAIT_OPTION || rest[index] === BUDGET_OPTION) {
    const name = rest[index] as string;
    const value = rest[index + 1];
    if (value === undefined || options.has(name)) return undefined;
    options.set(name, value);
    index += 2;
  }
  const [separator, command, ...commandArgs] = rest.slice(index);
  const budgetOption = options.get(BUDGET_OPTION);
  if (separator !== COMMAND_SEPARATOR || command === undefined || budgetOption === undefined) return undefined;
  return { runClass, waitOption: options.get(WAIT_OPTION), budgetOption, command, commandArgs };
};

type CpuBudget = typeof import('./support/cpu-budget.ts');

const endOf = async (budget: CpuBudget, command: string, commandArgs: readonly string[], env: Environment, budgetCpuSeconds: number): Promise<CommandEnd> => {
  const { child, end } = budget.startWithinBudget({ command, args: commandArgs, env, stdio: 'inherit', budgetCpuSeconds });
  const forwarders = FORWARDED_SIGNALS.map((signal) => {
    const forward = (): void => {
      if (child.pid !== undefined) killGroupWith(child.pid, signal);
    };
    process.on(signal, forward);
    return { signal, forward };
  });
  try {
    const ended = await end;
    return { kind: 'ended', code: ended.code, signal: ended.signal, breach: ended.breach, usedCpuSeconds: ended.usedCpuSeconds };
  } catch (error) {
    return { kind: 'not-started', message: error instanceof Error ? error.message : String(error) };
  } finally {
    for (const { signal, forward } of forwarders) process.off(signal, forward);
  }
};

const killGroupWith = (pgid: number, signal: NodeJS.Signals): void => {
  try {
    process.kill(-pgid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
};

const exitCodeOf = (end: Extract<CommandEnd, { kind: 'ended' }>): number => {
  if (end.signal !== null) return SIGNAL_EXIT_BASE + os.constants.signals[end.signal];
  if (end.code === null) throw new Error('the command ended with neither an exit code nor a signal');
  return end.code;
};

export const runUnderLock = async (argv: readonly string[], env: Environment): Promise<number> => {
  let lock: typeof import('./support/run-lock.ts');
  let devState: typeof import('./support/dev-state.ts');
  let budget: CpuBudget;
  try {
    [lock, devState, budget] = await Promise.all([import('./support/run-lock.ts'), import('./support/dev-state.ts'), import('./support/cpu-budget.ts')]);
  } catch (error) {
    const cause = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : error instanceof Error ? error.message : String(error);
    say(`run-lock: cannot use ${SUPPORT_DIR}: ${cause}`);
    return SUPPORT_UNLOADABLE_EXIT;
  }
  const { RUN_LOCK_ENV, RUN_LOCK_EXIT: EXIT, RUN_LOCK_WAIT_ENV, STOPPED_WHILE_WAITING_MESSAGE, acquireRunLock, causeOf, parseBudgetSeconds, parseWaitSeconds, runLockDirsOf, unusableMessage, untilStopped } = lock;

  const invocation = invocationOf(argv);
  if (invocation === undefined) {
    say(USAGE);
    return EXIT.usage;
  }
  const { runClass, waitOption, budgetOption, command, commandArgs } = invocation;

  let waitSeconds: number;
  let budgetCpuSeconds: number;
  try {
    budgetCpuSeconds = parseBudgetSeconds(budgetOption, BUDGET_OPTION);
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

  const stopExitOf = (signal: StoppingSignal): number => (signal === 'SIGINT' ? EXIT.interrupted : EXIT.terminated);

  const { result: outcome, stoppedBy } = await untilStopped((signal) =>
    acquireRunLock({
      runClass,
      ...runLockDirsOf(stateDir),
      command: [command, ...commandArgs].join(' '),
      cwd: process.cwd(),
      pid: process.pid,
      env,
      waitSeconds,
      signal,
      say,
    }),
  );

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
    end = await endOf(budget, command, commandArgs, outcome.kind === 'acquired' ? { ...env, [RUN_LOCK_ENV]: outcome.token } : env, budgetCpuSeconds);
  } finally {
    await release();
  }
  if (end.kind === 'not-started') {
    say(`run-lock: cannot start ${command}: ${end.message}`);
    return COMMAND_NOT_STARTED_EXIT;
  }
  if (end.breach !== undefined) {
    say(budget.breachLine(end.breach));
    return end.breach.kind === 'cpu' ? EXIT.cpuBudget : EXIT.starterGone;
  }
  say(budget.usageLine(end.usedCpuSeconds, budgetCpuSeconds));
  return exitCodeOf(end);
};

if (import.meta.main) process.exitCode = await runUnderLock(process.argv.slice(2), process.env);
