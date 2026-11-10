import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import type { ClipboardHost, ClipboardReadHost } from './clipboard.ts';

export type ClipboardPrograms = { pipe: ClipboardHost['pipe']; capture: ClipboardReadHost['capture']; stop(): void };

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
    capture: (file, args, maxBytes, signal) =>
      new Promise<Uint8Array | undefined>((resolve, reject) => {
        const child = spawn(file, [...args], { stdio: ['ignore', 'pipe', 'ignore'], signal });
        started.add(child);
        const chunks: Buffer[] = [];
        let size = 0;
        child.stdout.on('data', (chunk: Buffer) => {
          size += chunk.byteLength;
          if (size > maxBytes) child.kill();
          else chunks.push(chunk);
        });
        child.once('error', (error) => {
          started.delete(child);
          reject(error);
        });
        child.once('close', (code) => {
          started.delete(child);
          resolve(code === 0 && size <= maxBytes ? Buffer.concat(chunks) : undefined);
        });
      }),
    stop: () => {
      for (const child of started) child.kill();
      started.clear();
    },
  };
};
