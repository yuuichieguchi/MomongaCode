import path from 'node:path';
import type { Readable } from 'node:stream';
import { spawnTracked } from './test-support.ts';
import type { CleanupContext, TrackedChild } from './test-support.ts';

const HOLDER_MAIN = path.join(import.meta.dirname, 'lock-holder-main.ts');

export const startLockHolder = (context: CleanupContext, lockPath: string): Promise<TrackedChild> =>
  new Promise((resolve, reject) => {
    const child = spawnTracked(context, process.execPath, [HOLDER_MAIN, lockPath], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    (child.stderr as Readable).on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    const onData = (chunk: Buffer): void => {
      stdout += chunk.toString('utf8');
      if (!stdout.includes('\n')) return;
      (child.stdout as Readable).off('data', onData);
      child.off('exit', onExit);
      if (stdout.trim() === 'locked') resolve(child);
      else reject(new Error(`the lock holder printed ${JSON.stringify(stdout)}`));
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      (child.stdout as Readable).off('data', onData);
      reject(new Error(`the lock holder exited (code ${code}, signal ${signal}) before holding the lock: ${stderr}`));
    };
    (child.stdout as Readable).on('data', onData);
    child.once('exit', onExit);
  });
