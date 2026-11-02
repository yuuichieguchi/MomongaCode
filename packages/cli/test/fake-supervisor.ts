import fs from 'node:fs';
import http from 'node:http';
import type { MomongaPaths } from '@momonga/foundation';
import type { SupervisorChildHealth, SupervisorHealth } from '@momonga/protocol';
import type { SessionView } from '../src/client/views.ts';
import type { CliClock, DetachedExit, SpawnDetached } from '../src/ports.ts';
import { SESSION } from './fake-backend.ts';

export type FakeSupervisorOptions = {
  paths: MomongaPaths;
  version: string;
  children?: SupervisorChildHealth[];
  phase?: SupervisorHealth['phase'];
};

export const readyChildren = (): SupervisorChildHealth[] => [
  { role: 'gateway', state: 'ready', pid: 101, restarts: 0, consecutiveFailures: 0 },
  { role: 'runtime', state: 'ready', pid: 102, restarts: 0, consecutiveFailures: 0 },
];

export type FakeSupervisor = {
  readonly shutdowns: number;
  stop(): Promise<void>;
};

export const startFakeSupervisor = async (options: FakeSupervisorOptions): Promise<FakeSupervisor> => {
  const { paths } = options;
  let phase = options.phase ?? 'running';
  let shutdowns = 0;
  const server = http.createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/v1/health') {
      const health: SupervisorHealth = {
        status: 'ok',
        version: options.version,
        apiVersion: 1,
        pid: process.pid,
        startedAt: '2026-01-01T00:00:00.000Z',
        phase,
        env: 'frozen at supervisor start',
        children: options.children ?? readyChildren(),
        logs: { droppedLines: 0 },
      };
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(health));
      return;
    }
    if (request.method === 'POST' && request.url === '/v1/shutdown') {
      shutdowns += 1;
      phase = 'draining';
      response.writeHead(202, { 'content-type': 'application/json' }).end(JSON.stringify({ phase: 'draining' }));
      setImmediate(() => {
        void stop();
      });
      return;
    }
    response.writeHead(404).end();
  });
  fs.writeFileSync(paths.locks.supervisor, String(process.pid));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(paths.sockets.supervisor, resolve);
  });
  let stopping: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    stopping ??= new Promise<void>((resolve) => {
      server.close(() => {
        fs.rmSync(paths.locks.supervisor, { force: true });
        resolve();
      });
      server.closeAllConnections();
    });
    return stopping;
  };
  return {
    get shutdowns() {
      return shutdowns;
    },
    stop,
  };
};

export const virtualClock = (): CliClock => {
  let now = 0;
  return {
    now: () => now,
    sleep: async (ms) => {
      now += ms;
      await new Promise<void>((resolve) => setImmediate(resolve));
    },
  };
};

export type SpawnedProcess = { command: string; args: readonly string[] };

export const recordingSpawn = (onSpawn: (spec: SpawnedProcess) => Promise<DetachedExit> | undefined): { spawn: SpawnDetached; spawned: SpawnedProcess[] } => {
  const spawned: SpawnedProcess[] = [];
  const spawn: SpawnDetached = (spec) => {
    const record = { command: spec.command, args: spec.args };
    spawned.push(record);
    return { exit: onSpawn(record) ?? new Promise<DetachedExit>(() => undefined) };
  };
  return { spawn, spawned };
};

export const startFakeRuntime = async (paths: MomongaPaths, activeRunIds: readonly (string | null)[]): Promise<{ stop(): Promise<void> }> => {
  const sessions: SessionView[] = activeRunIds.map((activeRunId, index) => ({ ...SESSION, id: `session-${index}`, activeRunId }));
  const server = http.createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/v1/sessions') {
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ sessions }));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(paths.sockets.runtime, resolve);
  });
  return {
    stop: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
};
