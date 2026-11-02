import { spawn } from 'node:child_process';
import type { SecretProcessPort } from './secret-store.ts';

export const createExecWithStdin =
  (env: Readonly<Record<string, string>> | undefined): SecretProcessPort =>
  (file, args, stdin, signal) =>
    new Promise((resolve, reject) => {
      const child = spawn(file, [...args], { ...(env === undefined ? {} : { env: { ...env } }), stdio: ['pipe', 'pipe', 'pipe'], signal });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
      child.stdin.on('error', reject);
      child.once('error', reject);
      child.once('close', (code) => {
        resolve({
          exitCode: code ?? 1,
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
        });
      });
      child.stdin.end(stdin);
    });
