import { execFile } from 'node:child_process';
import type { ExecFileException } from 'node:child_process';

export type CommandOptions = { env: Readonly<Record<string, string>>; timeoutMs?: number; input?: string; signal?: AbortSignal };

export type CommandResult = { exitCode: number; stdout: string; stderr: string };

export type CommandRunner = (file: string, args: readonly string[], options: CommandOptions) => Promise<CommandResult>;

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
