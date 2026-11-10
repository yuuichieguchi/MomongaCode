import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import type { ClipboardHost } from './clipboard.ts';

export type ClipboardPrograms = { pipe: ClipboardHost['pipe']; stop(): void };

export const createClipboardPrograms = (): ClipboardPrograms => {
  const started = new Set<ChildProcess>();
  return {
    pipe: (file, args, payload) =>
      new Promise<void>((resolve, reject) => {
        const child = spawn(file, [...args], { stdio: ['pipe', 'ignore', 'ignore'] });
        started.add(child);
        child.once('exit', () => started.delete(child));
        child.once('error', (error) => {
          started.delete(child);
          reject(error);
        });
        child.stdin.once('error', reject);
        child.once('spawn', () => {
          child.unref();
          child.stdin.end(payload, 'utf8', () => resolve());
        });
      }),
    stop: () => {
      for (const child of started) child.kill();
      started.clear();
    },
  };
};
