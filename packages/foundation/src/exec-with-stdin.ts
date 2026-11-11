import { spawn } from 'node:child_process';
import type { SecretProcessPort } from './secret-store.ts';

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

export const createExecWithStdin =
  (env: Readonly<Record<string, string>> | undefined): SecretProcessPort =>
  (file, args, stdin, signal) =>
    new Promise((resolve, reject) => {
      signal.throwIfAborted();
      const child = spawn(file, [...args], { ...(env === undefined ? {} : { env: { ...env } }), stdio: ['pipe', 'pipe', 'pipe'], signal });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      const fail = (error: unknown): void => {
        signal.removeEventListener('abort', leaveChildBehind);
        reject(signal.aborted ? signal.reason : error);
      };
      const leaveChildBehind = (): void => {
        reject(signal.reason);
        child.unref();
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
      };
      signal.addEventListener('abort', leaveChildBehind, { once: true });
      child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
      child.stdin.on('error', fail);
      child.once('error', fail);
      child.once('close', (code, endedBy) => {
        signal.removeEventListener('abort', leaveChildBehind);
        if (code === null) {
          reject(endedBy === null ? new Error(`${file} ended with neither an exit code nor a signal`) : new ProgramSignalledError(file, endedBy));
          return;
        }
        resolve({
          exitCode: code,
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
        });
      });
      child.stdin.end(stdin);
    });
