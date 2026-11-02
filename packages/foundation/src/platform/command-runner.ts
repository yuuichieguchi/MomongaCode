import { execFile, execFileSync } from 'node:child_process';
import type { ExecFileException, ExecFileSyncOptions } from 'node:child_process';

export type CommandOptions = { env: Readonly<Record<string, string>>; timeoutMs?: number; input?: string; signal?: AbortSignal };

export type CommandResult = { exitCode: number; stdout: string; stderr: string };

export type CommandRunner = (file: string, args: readonly string[], options: CommandOptions) => Promise<CommandResult>;

export type SyncCommandRunner = (file: string, args: readonly string[], options: CommandOptions) => CommandResult;

const exitCodeOf = (error: ExecFileException): number | undefined => (typeof error.code === 'number' ? error.code : undefined);

export const nodeCommandRunner: CommandRunner = (file, args, options) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      file,
      [...args],
      {
        env: { ...options.env },
        ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        killSignal: 'SIGKILL',
        windowsHide: true,
        encoding: 'utf8',
      },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ exitCode: 0, stdout, stderr });
          return;
        }
        const exitCode = exitCodeOf(error);
        if (exitCode === undefined || error.killed === true) reject(error);
        else resolve({ exitCode, stdout, stderr });
      },
    );
    if (options.input !== undefined) child.stdin?.end(options.input);
  });

export const nodeSyncCommandRunner: SyncCommandRunner = (file, args, options) => {
  const execOptions: ExecFileSyncOptions & { encoding: 'utf8' } = {
    env: { ...options.env },
    ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
    killSignal: 'SIGKILL',
    windowsHide: true,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    ...(options.input === undefined ? {} : { input: options.input }),
  };
  try {
    return { exitCode: 0, stdout: execFileSync(file, [...args], execOptions), stderr: '' };
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { status?: number | null; stdout?: string; stderr?: string; signal?: string | null };
    if (typeof failure.status === 'number') return { exitCode: failure.status, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
    throw error;
  }
};
