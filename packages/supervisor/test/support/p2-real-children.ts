import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerCleanup, withTempDir } from '@momonga/testkit';
import type { CleanupContext } from '@momonga/testkit';
import type { ChildExit, ChildHandle, SpawnPortOptions } from '../../src/child-manager.ts';

export const CHILD_FIXTURE = fileURLToPath(new URL('../fixtures/p2-child.ts', import.meta.url));

export const readOnlyScratchFd = (context: CleanupContext): number => {
  const dir = withTempDir(context);
  const file = path.join(dir, 'scratch-marker');
  fs.writeFileSync(file, '', { mode: 0o600 });
  const fd = fs.openSync(file, 'r');
  registerCleanup(context, () => fs.closeSync(fd));
  return fd;
};

export const portOptions = (markerFd: number): SpawnPortOptions => ({
  cwd: process.cwd(),
  env: { PATH: '/usr/bin:/bin' },
  detached: true,
  stdio: ['ignore', 'pipe', 'pipe', 'pipe', markerFd],
});

export type WatchedHandle = { handle: ChildHandle; exit: Promise<ChildExit>; exited(): boolean; output(): string };

export const watch = (handle: ChildHandle): WatchedHandle => {
  let output = '';
  let done = false;
  handle.stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  handle.stderr.resume();
  const exit = new Promise<ChildExit>((resolve) =>
    handle.onExit((value) => {
      done = true;
      resolve(value);
    }),
  );
  return { handle, exit, exited: () => done, output: () => output };
};
