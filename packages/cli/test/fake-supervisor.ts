import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { FIRST_GENERATION, systemTiming, acquireProcessLock, formatStartRecord, generationLayout, publishCurrentGeneration } from '@momonga/foundation';
import type { HostExec, HostExecAnswer, MomongaPaths, ProcessLock } from '@momonga/foundation';
import { FIDELITY_FOLD_VERSION } from '@momonga/protocol';
import type { SupervisorChildHealth, SupervisorHealth } from '@momonga/protocol';
import type { CliClock, DetachedExit, SpawnDetached } from '../src/ports.ts';
import { testKernelLock, afterMicrotasks, testEndpointScope } from '@momonga/testkit';

export type FakeSupervisorOptions = {
  paths: MomongaPaths;
  version: string;
  children?: SupervisorChildHealth[];
  phase?: SupervisorHealth['phase'];
  unresponsiveShutdown?: { onRequest(): void };
  stopBoundMs?: number;
  keepsLock?: boolean;
  pid?: number;
  generation?: number;
  work?: FakeWork;
  publishGate?: Promise<void>;
  holdsKernelLock?: boolean;
  publishes?: boolean;
  startRecordVersion?: string;
  reports?: Pick<SupervisorHealth, 'steps' | 'jobs' | 'calls' | 'role' | 'interrupts'>;
};

export type FakeWork = {
  track<T>(work: Promise<T>): Promise<T>;
  settled(): Promise<void>;
};

export const createFakeWork = (): FakeWork => {
  const open = new Set<Promise<unknown>>();
  return {
    track: (work) => {
      const settled = work.then(
        () => undefined,
        () => undefined,
      );
      open.add(settled);
      void settled.then(() => open.delete(settled));
      return work;
    },
    settled: async () => {
      while (open.size > 0) await Promise.all(open);
    },
  };
};

const untracked: FakeWork = { track: (work) => work, settled: async () => undefined };

export const readyChildren = (): SupervisorChildHealth[] => [
  { role: 'gateway', state: 'ready', pid: 101, restarts: 0, consecutiveFailures: 0 },
  { role: 'runtime', state: 'ready', pid: 102, restarts: 0, consecutiveFailures: 0 },
];

export type FakeSupervisor = {
  readonly shutdowns: number;
  readonly shutdownBodies: readonly string[];
  readonly healthRequests: number;
  becomeReady(): Promise<void>;
  stop(): Promise<void>;
};

export const startFakeSupervisor = (options: FakeSupervisorOptions): Promise<FakeSupervisor> => (options.work ?? untracked).track(serveFakeSupervisor(options));

const serveFakeSupervisor = async (options: FakeSupervisorOptions): Promise<FakeSupervisor> => {
  const { paths } = options;
  const work = options.work ?? untracked;
  const generation = options.generation ?? FIRST_GENERATION;
  const layout = generationLayout(path.dirname(paths.root), generation);
  let phase = options.phase ?? 'running';
  let children = options.children ?? readyChildren();
  let healthRequests = 0;
  let shutdowns = 0;
  const shutdownBodies: string[] = [];
  const server = http.createServer((request, response) => {
    if (request.method === 'POST' && request.url === '/v1/shutdown' && options.unresponsiveShutdown !== undefined) {
      options.unresponsiveShutdown.onRequest();
      return;
    }
    if (request.method === 'GET' && request.url === '/v1/health') {
      healthRequests += 1;
      const health: SupervisorHealth = {
        status: 'ok',
        version: options.version,
        pid: options.pid ?? process.pid,
        startedAt: '2026-01-01T00:00:00.000Z',
        phase,
        env: 'frozen at supervisor start',
        children,
        logs: { droppedLines: 0 },
        ...(options.stopBoundMs === undefined ? {} : { stopBoundMs: options.stopBoundMs }),
        generation,
        ...options.reports,
      };
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(health));
      return;
    }
    if (request.method === 'POST' && request.url === '/v1/shutdown') {
      shutdowns += 1;
      phase = 'draining';
      let body = '';
      request.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
      request.on('end', () => {
        shutdownBodies.push(body);
        response.writeHead(202, { 'content-type': 'application/json' }).end(JSON.stringify({ phase: 'draining' }));
        if (options.keepsLock === true) return;
        setImmediate(() => {
          void stop();
        });
      });
      return;
    }
    response.writeHead(404).end();
  });
  fs.mkdirSync(layout.dir, { recursive: true, mode: 0o700 });
  if (!fs.existsSync(layout.startRecord)) fs.writeFileSync(layout.startRecord, formatStartRecord({ version: options.startRecordVersion ?? options.version, foldVersion: FIDELITY_FOLD_VERSION }), { mode: 0o600 });
  let kernelLock: ProcessLock | undefined;
  if (options.holdsKernelLock !== false) kernelLock = await acquireProcessLock(layout.locks.supervisor, undefined, { mechanism: testKernelLock() });
  else fs.writeFileSync(layout.locks.supervisor, String(process.pid));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(layout.sockets.supervisor, resolve);
  });
  const publish = async (): Promise<void> => {
    await options.publishGate;
    await publishCurrentGeneration(paths, { generation, version: options.version, sockets: layout.sockets }, { lock: testKernelLock() });
  };
  const publishWhenServing = (): Promise<void> =>
    options.publishes !== false && phase === 'running' && children.every((child) => child.state === 'ready') ? work.track(publish()) : Promise.resolve();
  const startPublish = publishWhenServing();
  if (options.publishGate === undefined) await startPublish;
  let stopping: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    stopping ??= new Promise<void>((resolve) => {
      server.close(() => {
        kernelLock?.release();
        fs.rmSync(layout.locks.supervisor, { force: true });
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
    get shutdownBodies() {
      return shutdownBodies;
    },
    get healthRequests() {
      return healthRequests;
    },
    becomeReady: async () => {
      children = readyChildren();
      await publishWhenServing();
    },
    stop,
  };
};

export const virtualClock = (work: FakeWork = untracked): CliClock => {
  let now = 0;
  return {
    now: () => now,
    sleep: async (ms) => {
      await work.settled();
      now += ms;
      await afterMicrotasks();
    },
  };
};

export type InstalledProgram = { ports: { exec: HostExec; timers: typeof systemTiming; endpointScope: typeof testEndpointScope }; asked: Array<{ file: string; args: readonly string[] }> };

export const installedProgram = (answer: string | (() => HostExecAnswer | Promise<HostExecAnswer>)): InstalledProgram => {
  const asked: InstalledProgram['asked'] = [];
  return {
    asked,
    ports: {
      timers: systemTiming,
      endpointScope: testEndpointScope,
      exec: async (file, args) => {
        asked.push({ file, args });
        return typeof answer === 'string' ? { exitCode: 0, stdout: `${answer}\n`, stderr: '' } : answer();
      },
    },
  };
};

export type SpawnedProcess = { command: string; args: readonly string[]; lifeline?: boolean };

export const recordingSpawn = (onSpawn: (spec: SpawnedProcess) => Promise<DetachedExit> | undefined): { spawn: SpawnDetached; spawned: SpawnedProcess[] } => {
  const spawned: SpawnedProcess[] = [];
  const spawn: SpawnDetached = (spec) => {
    const record = { command: spec.command, args: spec.args, ...(spec.lifeline === undefined ? {} : { lifeline: spec.lifeline }) };
    spawned.push(record);
    return { exit: onSpawn(record) ?? new Promise<DetachedExit>(() => undefined) };
  };
  return { spawn, spawned };
};

