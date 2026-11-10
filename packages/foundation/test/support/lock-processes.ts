import type { Readable } from 'node:stream';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SpawnOptions } from '@momonga/testkit/child-process';
import { spawnTracked } from '@momonga/testkit';
import type { CleanupContext, TrackedChild } from '@momonga/testkit';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

export const ADOPTER_FIXTURE = path.join(FIXTURES, 'lock-adopter.ts');

export const firstLine = (child: TrackedChild): Promise<string> =>
  new Promise((resolve, reject) => {
    let text = '';
    let stderr = '';
    const stdout = child.stdout as Readable;
    (child.stderr as Readable).on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    const onData = (chunk: Buffer): void => {
      text += chunk.toString('utf8');
      const newline = text.indexOf('\n');
      if (newline < 0) return;
      stdout.off('data', onData);
      child.off('exit', onExit);
      resolve(text.slice(0, newline));
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      stdout.off('data', onData);
      reject(new Error(`child ${child.pid} exited (code ${code}, signal ${signal}) before printing a line: ${stderr}`));
    };
    stdout.on('data', onData);
    child.once('exit', onExit);
  });

export const exitOf = (child: TrackedChild): Promise<{ code: number | null; signal: NodeJS.Signals | null }> =>
  new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({ code: child.exitCode, signal: child.signalCode });
      return;
    }
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });

export const spawnFixture = (context: CleanupContext, fixture: string, args: readonly string[], options: SpawnOptions = {}): TrackedChild =>
  spawnTracked(context, process.execPath, [fixture, ...args], { stdio: ['ignore', 'pipe', 'pipe'], ...options });

export { startLockHolder as startHolder } from '@momonga/testkit';
