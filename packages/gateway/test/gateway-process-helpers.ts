import { spawn } from '@momonga/testkit/child-process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { vi } from 'vitest';
import { FIRST_GENERATION, createUdsClient, fixedSocket, generationLayout, secretStoreEnvFor, shortTempBase } from '@momonga/foundation';
import type { UdsClient } from '@momonga/foundation';
import { startGatewayProcess } from '@momonga/gateway';
import { killPidsForCleanup, modelSettings } from '@momonga/testkit';
import type { ModelSettings } from '@momonga/testkit';
import type { FakeSecurityPort } from '@momonga/testkit';
import { registerCleanup } from './gateway-helpers.ts';

export const PROCESS_VERSION = '1.10.0-test';
export const MINIMAL_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

export type GatewayProcessOptions = Parameters<typeof startGatewayProcess>[0];
export type GatewayProcessHandle = Awaited<ReturnType<typeof startGatewayProcess>>;

export const makeHome = (): string => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(shortTempBase(process.platform), 'gh-')));
  fs.chmodSync(home, 0o700);
  registerCleanup(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
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

export const CC_MODEL = 'system';

export const ccTarget = (socketPath: string, extra: Record<string, unknown> = {}) => ({
  adapter: 'chat-completions',
  model: CC_MODEL,
  socketPath,
  capabilities: { contextWindow: 4096, maxOutputTokens: 1024 },
  ...extra,
});

export type ServerModel = Record<string, unknown>;

export type ModelsRest = { fallbackTo?: readonly string[]; [key: string]: unknown };

const ownNameOf = (server: string, flat: ServerModel | undefined): string => {
  const model = flat?.['model'];
  if (typeof model !== 'string') throw new Error(`the test server ${JSON.stringify(server)} names no model`);
  return model;
};

export const modelOf = (servers: Record<string, ServerModel>, server: string): string => `${servers[server]?.['provider'] ?? server}/${ownNameOf(server, servers[server])}`;

export const modelsOf = (servers: Record<string, ServerModel>, rest: ModelsRest = {}): ModelSettings['models'] => {
  const { fallbackTo, ...keys } = rest;
  return modelSettings({
    models: Object.entries(servers).map(([server, flat]) => {
      const { model: _model, ...spec } = flat;
      return { provider: server, id: ownNameOf(server, flat), ...spec };
    }),
    ...(fallbackTo === undefined ? {} : { fallback: fallbackTo.map((server) => modelOf(servers, server)) }),
    ...keys,
  }).models;
};
