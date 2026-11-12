import { systemWaitTiming } from '../system-timing.ts';
import { launchGroupLeader } from './group-launch.ts';
import { CONTROL_PLANE_LAUNCH } from '../child-protection.ts';
import type { LeaderExit } from './group-launch.ts';

type CommandInputs = { env: Readonly<Record<string, string>> | undefined; input?: string; signal?: AbortSignal | undefined };

export type CommandOptions = CommandInputs & { timeoutMs?: never };

export type BoundedCommandOptions = CommandInputs & { timeoutMs: number };

export type CommandResult = { exitCode: number; stdout: string; stderr: string };

export type CommandTimedOut = { timedOut: true; timeoutMs: number; stdout: string; stderr: string };

export type CommandRunner = (file: string, args: readonly string[], options: CommandOptions) => Promise<CommandResult>;

export type BoundedCommandRunner = (file: string, args: readonly string[], options: BoundedCommandOptions) => Promise<CommandResult | CommandTimedOut>;

export const COMMAND_OUTPUT_MAX_BYTES = 1024 * 1024;

export class ProgramSignalledError extends Error {
  readonly file: string;
  readonly signal: NodeJS.Signals;
  constructor(file: string, signal: NodeJS.Signals) {
    super(`${file} was ended by the signal ${signal} before it answered`);
    this.name = 'ProgramSignalledError';
    this.file = file;
    this.signal = signal;
  }
}

export class CommandOutputTooLargeError extends Error {
  readonly file: string;
  constructor(file: string) {
    super(`${file} printed more than ${COMMAND_OUTPUT_MAX_BYTES} bytes on one stream, so it was ended`);
    this.name = 'CommandOutputTooLargeError';
    this.file = file;
  }
}

type Ending = { exit: LeaderExit; timedOut: boolean; stdout: string; stderr: string };

const run = async (file: string, args: readonly string[], options: CommandInputs, timeoutMs: number | undefined): Promise<Ending> => {
  const { signal } = options;
  signal?.throwIfAborted();
  const launch = await launchGroupLeader({ file, args, ...(options.env === undefined ? {} : { env: options.env }), stdio: ['pipe', 'pipe', 'pipe'], protection: CONTROL_PLANE_LAUNCH });
  return new Promise((resolve, reject) => {
    const { child } = launch;
    const stdin = child.stdin;
    const stdoutStream = child.stdout;
    const stderrStream = child.stderr;
    if (stdin === null || stdoutStream === null || stderrStream === null) throw new Error(`${file} was started without its three pipes`);
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timedOut = false;
    let settled = false;
    let exit: LeaderExit | undefined;
    let closed = false;
    const bound = timeoutMs === undefined ? undefined : systemWaitTiming.setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    const finish = (): void => {
      settled = true;
      if (bound !== undefined) systemWaitTiming.clearTimeout(bound);
      signal?.removeEventListener('abort', leaveChildBehind);
    };
    const fail = (error: unknown): void => {
      if (settled) return;
      finish();
      reject(error);
    };
    const leaveChildBehind = (): void => {
      if (settled) return;
      finish();
      reject(signal?.reason);
      child.kill('SIGTERM');
      child.unref();
      stdin.destroy();
      stdoutStream.destroy();
      stderrStream.destroy();
    };
    const ended = (): void => {
      if (settled || exit === undefined || !closed) return;
      finish();
      resolve({ exit, timedOut, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') });
    };
    const collect = (into: Buffer[]) => (chunk: Buffer): void => {
      into.push(chunk);
      if (into.reduce((total, part) => total + part.length, 0) <= COMMAND_OUTPUT_MAX_BYTES) return;
      child.kill('SIGKILL');
      fail(new CommandOutputTooLargeError(file));
    };
    signal?.addEventListener('abort', leaveChildBehind, { once: true });
    if (signal?.aborted === true) leaveChildBehind();
    stdoutStream.on('data', collect(stdout));
    stderrStream.on('data', collect(stderr));
    stdin.on('error', fail);
    child.once('error', fail);
    child.once('close', () => {
      closed = true;
      ended();
    });
    launch.onExit((leader) => {
      exit = leader;
      ended();
    }, fail);
    if (options.input === undefined) stdin.end();
    else stdin.end(options.input);
  });
};

const exited = (file: string, { exit, stdout, stderr }: Ending): CommandResult => {
  if (exit.code !== null) return { exitCode: exit.code, stdout, stderr };
  if (exit.signal === null) throw new Error(`${file} ended with neither an exit code nor a signal`);
  throw new ProgramSignalledError(file, exit.signal);
};

export const nodeCommandRunner: CommandRunner = async (file, args, options) => exited(file, await run(file, args, options, undefined));

export const nodeBoundedCommandRunner: BoundedCommandRunner = async (file, args, options) => {
  const ending = await run(file, args, options, options.timeoutMs);
  return ending.timedOut ? { timedOut: true, timeoutMs: options.timeoutMs, stdout: ending.stdout, stderr: ending.stderr } : exited(file, ending);
};
