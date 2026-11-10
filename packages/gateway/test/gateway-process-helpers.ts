import { spawn } from '@momonga/testkit/child-process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { vi } from 'vitest';
import { FIRST_GENERATION, SWEEP_INTERVAL_MS, createUdsClient, fixedSocket, generationLayout, momongaPaths, secretStoreEnvFor, shortTempBase } from '@momonga/foundation';
import type { UdsClient } from '@momonga/foundation';
import { startGatewayProcess } from '@momonga/gateway';
import { killPidsForCleanup, prepareGenerationForTest } from '@momonga/testkit';
import type { FakeSecurityPort, PendingTimer } from '@momonga/testkit';
import { registerCleanup } from './gateway-helpers.ts';

export const PROCESS_VERSION = '1.10.0-test';
export const MINIMAL_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

export const notTheRoleTick = (timer: PendingTimer): boolean => timer.delayMs !== SWEEP_INTERVAL_MS;

export type GatewayProcessOptions = Parameters<typeof startGatewayProcess>[0];
export type GatewayProcessHandle = Awaited<ReturnType<typeof startGatewayProcess>>;

export const makeHome = (): string => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(shortTempBase(process.platform), 'gh-')));
  fs.chmodSync(home, 0o700);
  registerCleanup(() => fs.rmSync(home, { recursive: true, force: true }));
  prepareHome(home);
  return home;
};

export const prepareHome = (home: string, generation: number = FIRST_GENERATION): void => {
  const paths = momongaPaths(home, process.platform, {});
  const directories = [paths.root, paths.run, paths.callLocks, paths.lockProof, paths.markers.root, paths.state, paths.traces.dir, paths.probe, paths.logs, paths.projects, paths.skills, paths.cacheBase, paths.tmp.root, paths.tmp.spawn, paths.tmp.sessions];
  for (const directory of directories) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  prepareGenerationForTest(home, generation, PROCESS_VERSION);
};

export const homePaths = (home: string) => {
  const root = path.join(home, '.momonga');
  const own = generationLayout(home, FIRST_GENERATION);
  return {
    root,
    settings: path.join(root, 'settings.json'),
    socket: own.sockets.gateway,
    lock: own.locks.gateway,
    fmSocket: path.join(root, 'run', `g${FIRST_GENERATION}`, 'targets', 'fm-1.sock'),
    fmMarkers: path.join(root, 'run', 'markers', `g${FIRST_GENERATION}`, 'targets', 'fm-1'),
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

export type SecretHostProgram = { program: string; canonicalBinary: string; extraEnv: Record<string, string> };

export type SecretHost = { env: Record<string, string>; programPath: string };

export const fakeSecretHost = (bin: string, store: SecretHostProgram): SecretHost => {
  const programPath = path.join(bin, store.program);
  fs.writeFileSync(programPath, '#!/bin/sh\nexit 97\n', { mode: 0o755 });
  return { env: secretStoreEnvFor({ PATH: bin, ...store.extraEnv }), programPath };
};

export const portOnSecretHost = (inner: FakeSecurityPort, store: SecretHostProgram, host: SecretHost): FakeSecurityPort => {
  const calls: FakeSecurityPort['calls'] = [];
  const port = async (file: string, args: readonly string[], stdin: string, signal: AbortSignal) => {
    calls.push({ file, args, stdin });
    if (file !== host.programPath) throw new Error(`the gateway ran ${file}, not the fake ${store.program} on PATH at ${host.programPath}`);
    return inner(store.canonicalBinary, args, stdin, signal);
  };
  return Object.assign(port, { calls });
};

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
  const client = createUdsClient(fixedSocket(socketPath));
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
  provider: 'fake',
  model: 'system',
  socketPath,
  capabilities: { contextWindow: 4096, maxOutputTokens: 1024 },
  ...extra,
});
