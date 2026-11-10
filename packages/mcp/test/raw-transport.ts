import { execFile } from '@momonga/testkit/child-process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach } from 'vitest';
import type { McpStdioServerConfig } from '@momonga/config';
import { groupAlive, groupTerminationBoundMs } from '@momonga/foundation';
import { createStdioTransport } from '@momonga/mcp';
import type { StdioTransport, StdioTransportOptions } from '@momonga/mcp';
import { LSOF_PATH, MCP_RAW_STDIO_SERVER_PATH, killGroupsForCleanup, killPidsForCleanup } from '@momonga/testkit';
import { DEFAULT_CLOSE_GRACE_MS } from '../src/stdio-transport.ts';

export const transportCloseBoundMs = (closeGraceMs: number): number => closeGraceMs + groupTerminationBoundMs(closeGraceMs) + closeGraceMs + 2 * closeGraceMs;

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  const failures: unknown[] = [];
  for (const cleanup of cleanups.splice(0).reverse()) {
    try {
      await cleanup();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, 'test cleanup failed');
}, transportCloseBoundMs(DEFAULT_CLOSE_GRACE_MS));

export const onCleanup = (cleanup: () => Promise<void> | void): void => {
  cleanups.push(cleanup);
};

export const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

export const groupExists = (pgid: number): Promise<boolean> => groupAlive(pgid);

export const makeDir = (prefix = 'mm-mcp-mk-'): string => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  onCleanup(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

export const trackPid = (pid: number): void => {
  onCleanup(() => {
    if (pid > 1 && pidAlive(pid)) killPidsForCleanup([pid]);
  });
};

export const eventually = async (condition: () => boolean | Promise<boolean>, description: string): Promise<void> => {
  for (let attempt = 0; attempt < 4000; attempt += 1) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`condition not reached: ${description}`);
};

export const descriptorPath = (pid: number, fd: number): Promise<string | undefined> =>
  new Promise((resolve, reject) => {
    execFile(LSOF_PATH, ['-a', '-p', String(pid), '-d', String(fd), '-Fn'], { env: { LC_ALL: 'C' } }, (error, stdout) => {
      if (error !== null && String(error.code) !== '1') {
        reject(error);
        return;
      }
      const name = stdout.split('\n').find((line) => line.startsWith('n'));
      resolve(name === undefined ? undefined : name.slice(1));
    });
  });

export const BASE_ENV: Record<string, string> = { PATH: '/usr/bin:/bin', HOME: '/home/fixture-user', USER: 'fixture-user' };

export type MarkerOptions = { dir: string; onWarning(message: string): void };

export type RawHarness = {
  transport: StdioTransport;
  closes: () => number;
  request(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
};

export const rawConfig = (modes: string[] = [], extra: Partial<McpStdioServerConfig> = {}): McpStdioServerConfig => ({
  command: process.execPath,
  args: [MCP_RAW_STDIO_SERVER_PATH, ...modes],
  ...extra,
});

export const createTransport = (options: {
  config: McpStdioServerConfig;
  projectDir?: string;
  baseEnv?: Record<string, string>;
  markers?: MarkerOptions;
  closeGraceMs?: number;
  terminate?: StdioTransportOptions['terminate'];
}): StdioTransport => {
  const transport = createStdioTransport({
    name: 'raw',
    config: options.config,
    projectDir: options.projectDir ?? makeDir(),
    baseEnv: options.baseEnv ?? BASE_ENV,
    ...(options.closeGraceMs === undefined ? {} : { closeGraceMs: options.closeGraceMs }),
    ...(options.markers === undefined ? {} : { markers: options.markers }),
    ...(options.terminate === undefined ? {} : { terminate: options.terminate }),
  } as StdioTransportOptions);
  onCleanup(async () => {
    const pgid = transport.pgid;
    await transport.close().catch(() => undefined);
    if (pgid !== undefined && pgid > 1) await killGroupsForCleanup([pgid]);
  });
  return transport;
};

export const startRaw = async (options: Parameters<typeof createTransport>[0]): Promise<RawHarness> => {
  const transport = createTransport(options);
  let closes = 0;
  const waiters = new Map<number, (message: Record<string, unknown>) => void>();
  transport.onmessage = (message) => {
    const record = message as Record<string, unknown>;
    const id = record['id'];
    if (typeof id === 'number') waiters.get(id)?.(record);
  };
  transport.onclose = () => {
    closes += 1;
    for (const waiter of waiters.values()) waiter({ error: 'transport closed' });
    waiters.clear();
  };
  await transport.start();
  let nextId = 1;
  const request = (method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
    const id = nextId;
    nextId += 1;
    const response = new Promise<Record<string, unknown>>((resolve, reject) => {
      waiters.set(id, (message) => {
        waiters.delete(id);
        if ('error' in message) reject(new Error(JSON.stringify(message['error'])));
        else resolve(message['result'] as Record<string, unknown>);
      });
    });
    return transport.send({ jsonrpc: '2.0', id, method, params }).then(() => response);
  };
  return { transport, closes: () => closes, request };
};
