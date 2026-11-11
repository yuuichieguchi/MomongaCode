import { execFile } from 'node:child_process';
import type { ExecFileException } from 'node:child_process';

type CommandInputs = { env: Readonly<Record<string, string>>; input?: string; signal?: AbortSignal | undefined };

export type CommandOptions = CommandInputs & { timeoutMs?: never };

export type BoundedCommandOptions = CommandInputs & { timeoutMs: number };

export type CommandResult = { exitCode: number; stdout: string; stderr: string };

export type CommandTimedOut = { timedOut: true; timeoutMs: number; stdout: string; stderr: string };

export type CommandRunner = (file: string, args: readonly string[], options: CommandOptions) => Promise<CommandResult>;

export type BoundedCommandRunner = (file: string, args: readonly string[], options: BoundedCommandOptions) => Promise<CommandResult | CommandTimedOut>;

type Ending = { error: ExecFileException | null; stdout: string; stderr: string };

const exitCodeOf = (error: ExecFileException): number | undefined => (typeof error.code === 'number' ? error.code : undefined);

const run = (file: string, args: readonly string[], options: CommandInputs, timeoutMs: number | undefined): Promise<Ending> =>
  new Promise((resolve) => {
    const child = execFile(
      file,
      [...args],
      {
        env: { ...options.env },
        ...(timeoutMs === undefined ? {} : { timeout: timeoutMs }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        killSignal: 'SIGKILL',
        windowsHide: true,
        encoding: 'utf8',
      },
      (error, stdout, stderr) => resolve({ error, stdout, stderr }),
    );
    if (options.input !== undefined) child.stdin?.end(options.input);
  });

const exited = ({ error, stdout, stderr }: Ending): CommandResult => {
  if (error === null) return { exitCode: 0, stdout, stderr };
  const exitCode = exitCodeOf(error);
  if (exitCode === undefined || error.killed === true) throw error;
  return { exitCode, stdout, stderr };
};

const endedByItsBound = (error: ExecFileException | null): boolean => error !== null && error.killed === true && error.name !== 'AbortError' && typeof error.code !== 'string';

export const nodeCommandRunner: CommandRunner = async (file, args, options) => exited(await run(file, args, options, undefined));

export const nodeBoundedCommandRunner: BoundedCommandRunner = async (file, args, options) => {
  const ending = await run(file, args, options, options.timeoutMs);
  return endedByItsBound(ending.error) ? { timedOut: true, timeoutMs: options.timeoutMs, stdout: ending.stdout, stderr: ending.stderr } : exited(ending);
};
