import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { vi } from 'vitest';
import { createUdsClient } from '@momonga/foundation';
import type { UdsClient } from '@momonga/foundation';
import { startGatewayProcess } from '@momonga/gateway';
import { killPidsForCleanup } from '@momonga/testkit';
import { registerCleanup } from './gateway-helpers.ts';

export const PROCESS_VERSION = '1.10.0-test';
export const MINIMAL_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

export type GatewayProcessOptions = Parameters<typeof startGatewayProcess>[0];
export type GatewayProcessHandle = Awaited<ReturnType<typeof startGatewayProcess>>;

export const makeHome = (): string => {
  const home = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'gh-'));
  fs.chmodSync(home, 0o700);
  registerCleanup(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
};

export const homePaths = (home: string) => {
  const root = path.join(home, '.momonga');
  return {
    root,
    settings: path.join(root, 'settings.json'),
    socket: path.join(root, 'run', 'gateway.sock'),
    lock: path.join(root, 'run', 'gateway.lock'),
    fmSocket: path.join(root, 'run', 'fm.sock'),
    fmMarkers: path.join(root, 'run', 'markers', 'fm'),
    db: path.join(root, 'state', 'gateway.db'),
    key: path.join(root, 'state', 'gateway.key'),
  };
};

export const writeSettings = (home: string, settings: unknown): void => {
  const { root, settings: file } = homePaths(home);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(settings), { mode: 0o600 });
};

export const baseEnv = (home: string, extra: Record<string, string> = {}): Record<string, string> => ({
  PATH: MINIMAL_PATH,
  HOME: home,
  TMPDIR: home,
  ...extra,
});

export type StdoutCapture = { lines(): string[] };

export const captureStdout = (): StdoutCapture => {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  }) as typeof process.stdout.write);
  registerCleanup(() => spy.mockRestore());
  return { lines: () => chunks.join('').split('\n').filter((line) => line !== '') };
};

export const launchGateway = async (options: GatewayProcessOptions): Promise<GatewayProcessHandle> => {
  const handle = await startGatewayProcess(options);
  registerCleanup(async () => {
    await handle.close();
  });
  return handle;
};

export const clientFor = (socketPath: string): UdsClient => {
  const client = createUdsClient(socketPath);
  registerCleanup(() => client.close());
  return client;
};

export const spawnSleeper = (): number => {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], { stdio: 'ignore' });
  const pid = child.pid;
  if (pid === undefined) throw new Error('could not spawn a sleeper process');
  registerCleanup(() => killPidsForCleanup([pid]));
  return pid;
};

export const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export const until = async (predicate: () => boolean | Promise<boolean>, description: string, timeoutMs = 20_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${description}`);
    await pause(25);
  }
};

export const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

export const ccTarget = (socketPath: string, extra: Record<string, unknown> = {}) => ({
  adapter: 'chat-completions',
  model: 'system',
  socketPath,
  capabilities: { contextWindow: 4096, maxOutputTokens: 1024 },
  ...extra,
});
