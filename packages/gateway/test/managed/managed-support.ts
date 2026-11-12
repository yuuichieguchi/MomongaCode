import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import * as gateway from '@momonga/gateway';
import * as protocol from '@momonga/protocol';
import { createTempDir, FAKE_SERVER, FAKE_SERVER_KEY_MISSING_EXIT, FAKE_SERVER_REFUSAL, FAKE_SERVER_REMEDY, TEST_UNPROTECTED_LAUNCH, testKernelLock, testProcessInspector } from '@momonga/testkit';
import { systemTiming } from '@momonga/foundation';
import type { ChildLaunch, ChildProtection, KernelLockMechanism, ProcessInspector } from '@momonga/foundation';

export type ExecAnswer = { exitCode: number; stdout: string; stderr: string };
export type ExecPort = (file: string, args: readonly string[], options: { signal: AbortSignal }) => Promise<ExecAnswer>;

export type ManagedTimers = { setTimeout(callback: () => void, ms: number): unknown; clearTimeout(handle: unknown): void; now(): number };

export type ManagedEndpoint = { kind: 'unix'; path: string };

export type HealthAnswer = { ok: boolean; reason?: string; detail?: string; remediation?: string };

export interface ManagedServerHandle {
  readonly restarts: number;
  start(signal?: AbortSignal): Promise<ManagedEndpoint>;
  ensureRunning(signal?: AbortSignal): Promise<ManagedEndpoint>;
  stop(stop?: { stopGraceMs: number }): Promise<void>;
  health(signal: AbortSignal): Promise<HealthAnswer>;
}

export type ManagedServerOptions = {
  description: unknown;
  target: string;
  binary: string;
  socketPath: string;
  lockPath: string;
  lock?: KernelLockMechanism;
  inspector?: ProcessInspector;
  markerDirectory?: string;
  readyTimeoutMs: number;
  exec?: ExecPort;
  launch?: ChildLaunch;
  spawn?: (file: string, args: readonly string[], protection: ChildProtection) => FakeChild;
  timers?: ManagedTimers;
  readStopGraceMs: () => number;
  onWarning: (message: string) => void;
};

export const exportOf = <T>(module: unknown, name: string, from: string): T => {
  const value = (module as Record<string, unknown>)[name];
  if (value === undefined) throw new Error(`${from} does not export ${name}`);
  return value as T;
};

export const createManagedServer = (options: ManagedServerOptions): ManagedServerHandle =>
  exportOf<(options: ManagedServerOptions) => ManagedServerHandle>(gateway, 'createManagedServer', '@momonga/gateway')({ lock: testKernelLock(), inspector: testProcessInspector(), timers: systemTiming, launch: TEST_UNPROTECTED_LAUNCH, ...options });

export const fmServer = (): Record<string, unknown> & { ready: { path: string }; restart: Record<string, number> } =>
  exportOf(protocol, 'FM_SERVER', '@momonga/protocol');

export type ServerKind = {
  label: string;
  description: () => Record<string, unknown>;
  target: string;
  argvOf(socketPath: string): string[];
  readyPath: string;
  refusingExec: ExecPort;
  refusal: { message: string; remediation: string };
  metExec: ExecPort;
};

const answer = (exitCode: number, stdout = '', stderr = ''): ExecAnswer => ({ exitCode, stdout, stderr });

export const SERVER_KINDS: ServerKind[] = [
  {
    label: 'the second kind (fake)',
    description: () => ({ ...FAKE_SERVER }),
    target: 'workbench',
    argvOf: (socketPath) => ['run', '--socket', socketPath],
    readyPath: '/ready',
    refusingExec: async (_file, args) => (args[0] === 'check-env' ? answer(FAKE_SERVER_KEY_MISSING_EXIT, '', 'FAKE_KEY is not set') : answer(0)),
    refusal: { message: `the model "workbench" is not ready: ${FAKE_SERVER_REFUSAL}`, remediation: FAKE_SERVER_REMEDY },
    metExec: async () => answer(0),
  },
  {
    label: 'fm',
    description: () => ({ ...fmServer() }),
    target: 'apple',
    argvOf: (socketPath) => ['serve', '--socket', socketPath],
    readyPath: '/health',
    refusingExec: async (_file, args) => (args[0] === 'license' ? answer(69, '', 'The license agreement has not been accepted.') : answer(0)),
    refusal: { message: 'the model "apple" is not ready: the Apple Foundation Models licence has not been accepted', remediation: 'sudo fm license' },
    metExec: async () => answer(0),
  },
];

export type FakeChildOptions = { manualServe?: boolean; dieOnSpawn?: boolean; neverReady?: boolean };

export class FakeChild extends EventEmitter {
  readonly signals: NodeJS.Signals[] = [];
  alive = true;
  private server: http.Server | undefined;
  private readonly socketPath: string;
  private readonly readyPath: string;
  private readonly options: FakeChildOptions;

  constructor(socketPath: string, readyPath: string, options: FakeChildOptions) {
    super();
    this.socketPath = socketPath;
    this.readyPath = readyPath;
    this.options = options;
    if (options.dieOnSpawn === true) {
      setImmediate(() => void this.crash(1, null));
      return;
    }
    if (options.manualServe !== true) void this.serveNow();
  }

  async serveNow(): Promise<void> {
    const server = http.createServer((request, response) => {
      const ready = request.method === 'GET' && request.url === this.readyPath && this.options.neverReady !== true;
      response.writeHead(ready ? 200 : 404, { 'content-type': 'application/json' });
      response.end(JSON.stringify(ready ? { ready: true } : { error: 'no such route' }));
    });
    await new Promise<void>((resolve) => server.listen(this.socketPath, () => resolve()));
    if (!this.alive) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      return;
    }
    this.server = server;
  }

  async kill(signal: NodeJS.Signals = 'SIGTERM'): Promise<boolean> {
    this.signals.push(signal);
    void this.crash(null, signal);
    return true;
  }

  async crash(code: number | null, signal: NodeJS.Signals | null): Promise<void> {
    if (!this.alive) return;
    this.alive = false;
    const server = this.server;
    this.server = undefined;
    if (server !== undefined) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    fs.rmSync(this.socketPath, { force: true });
    this.emit('exit', code, signal);
  }
}

export type PendingTimer = { id: number; ms: number; callback: () => void };

export const POLL_MS = 25;

export const createManualTimers = () => {
  let clock = 0;
  let nextId = 1;
  const pending = new Map<number, PendingTimer>();
  const timers: ManagedTimers = {
    setTimeout: (callback, ms) => {
      if (ms === POLL_MS) {
        setImmediate(callback);
        return 0;
      }
      const id = nextId;
      nextId += 1;
      pending.set(id, { id, ms, callback });
      return id;
    },
    clearTimeout: (handle) => {
      pending.delete(handle as number);
    },
    now: () => clock,
  };
  return {
    timers,
    delays: (): number[] => [...pending.values()].map((timer) => timer.ms),
    fire: (ms: number): void => {
      const timer = [...pending.values()].find((candidate) => candidate.ms === ms);
      if (timer === undefined) throw new Error(`no pending timer with delay ${ms}`);
      pending.delete(timer.id);
      clock += ms;
      timer.callback();
    },
  };
};

export const makeShortDir = (dirs: string[]): string => {
  const dir = createTempDir();
  fs.chmodSync(dir, 0o700);
  dirs.push(dir);
  return dir;
};
