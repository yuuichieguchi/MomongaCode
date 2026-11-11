import { spawnSync } from '@momonga/testkit/child-process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Agent } from 'undici';
import { createManagedServer, type ExecOptions, type ExecResult, type ManagedServer, type ManagedServerTimers } from '@momonga/gateway';
import { KILL_CONFIRM_MS } from '@momonga/foundation';
import { REAL_PROCESS_TEST_TIMEOUT_MS, startFakeChatCompletions, type FakeChatCompletionsServer } from '@momonga/testkit';
import { FM_SERVER } from '@momonga/protocol';
import type { GenerationRole } from '@momonga/foundation';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

interface FakeChildOptions {
  manualServe?: boolean;
  healthy?: boolean;
  serve?: boolean;
  ignoreSigterm?: boolean;
  ignoreSigkill?: boolean;
  dieOnSpawn?: boolean;
  errorOnSpawn?: Error;
}

class FakeChild extends EventEmitter {
  readonly pid: number;
  readonly signals: NodeJS.Signals[] = [];
  readonly events: string[];
  alive = true;
  private server: FakeChatCompletionsServer | undefined;
  private silent: net.Server | undefined;
  private readonly silentConnections = new Set<net.Socket>();
  private readonly options: FakeChildOptions;
  private readonly socketPath: string;

  constructor(pid: number, socketPath: string, options: FakeChildOptions, events: string[]) {
    super();
    this.pid = pid;
    this.socketPath = socketPath;
    this.options = options;
    this.events = events;
    if (options.errorOnSpawn !== undefined) {
      const error = options.errorOnSpawn;
      this.alive = false;
      setImmediate(() => this.emit('error', error));
      return;
    }
    if (options.dieOnSpawn === true) {
      setImmediate(() => void this.crash(1, null));
      return;
    }
    if (options.serve !== false && options.manualServe !== true) void this.serveNow();
  }

  async serveNow(): Promise<void> {
    const server = await startFakeChatCompletions({
      scenario: 'tools-ok',
      socketPath: this.socketPath,
      ...(this.options.healthy === undefined ? {} : { healthy: this.options.healthy }),
    });
    this.events.push(`serving:${this.pid}`);
    if (!this.alive) {
      await server.close();
      return;
    }
    this.server = server;
  }

  async replaceServerWithSilentOne(): Promise<void> {
    await this.server?.close();
    this.server = undefined;
    fs.rmSync(this.socketPath, { force: true });
    const silent = net.createServer((socket) => {
      this.silentConnections.add(socket);
      socket.on('error', () => undefined);
      socket.once('close', () => this.silentConnections.delete(socket));
    });
    this.silent = silent;
    await new Promise<void>((resolve) => silent.listen(this.socketPath, () => resolve()));
  }

  async kill(signal: NodeJS.Signals = 'SIGTERM'): Promise<boolean> {
    this.signals.push(signal);
    if (signal === 'SIGTERM' && this.options.ignoreSigterm === true) return true;
    if (signal === 'SIGKILL' && this.options.ignoreSigkill === true) return true;
    void this.crash(null, signal);
    return true;
  }

  async crash(code: number | null, signal: NodeJS.Signals | null): Promise<void> {
    if (!this.alive) return;
    this.alive = false;
    await this.server?.close();
    for (const socket of this.silentConnections) socket.destroy();
    if (this.silent !== undefined) await new Promise<void>((resolve) => this.silent?.close(() => resolve()));
    fs.rmSync(this.socketPath, { force: true });
    this.emit('exit', code, signal);
  }
}

interface PendingTimer {
  id: number;
  ms: number;
  callback: () => void;
}

const createManualTimers = () => {
  let clock = 0;
  let nextId = 1;
  const pending = new Map<number, PendingTimer>();
  const scheduled: number[] = [];
  const timers: ManagedServerTimers = {
    setTimeout: (callback, ms) => {
      if (ms === POLL_MS) {
        setImmediate(callback);
        return 0;
      }
      const id = nextId;
      nextId += 1;
      pending.set(id, { id, ms, callback });
      scheduled.push(ms);
      return id;
    },
    clearTimeout: (handle) => {
      pending.delete(handle as number);
    },
    now: () => clock,
  };
  return {
    timers,
    scheduled,
    advance: (ms: number): void => {
      clock += ms;
    },
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

const asking = (): AbortSignal => new AbortController().signal;

const POLL_MS = 25;
const HEALTH_MS = 400;
const RESET_MS = 5000;
const BACKOFF_MS = 50;
const GRACE_MS = 30;

const closedAgents = (spy: { mock: { contexts: unknown[] } }): number => new Set(spy.mock.contexts).size;

const children: FakeChild[] = [];
const dirs: string[] = [];
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  for (const child of children.splice(0)) await child.crash(0, null);
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const makeSocketPath = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-'));
  fs.chmodSync(dir, 0o700);
  dirs.push(dir);
  return path.join(dir, 'fm.sock');
};

const okExec = async (_file: string, _args: readonly string[]): Promise<ExecResult> => ({
  exitCode: 0,
  stdout: '',
  stderr: '',
});

interface SetupConfig {
  child?: FakeChildOptions | ((index: number) => FakeChildOptions);
  exec?: (file: string, args: readonly string[], options?: ExecOptions) => Promise<ExecResult>;
  maxRestarts?: number;
  preconditionTtlMs?: number;
  socketPath?: string;
  readStopGraceMs?: () => number;
  markerDirectory?: string;
  role?: { current(): GenerationRole };
}

const setup = (config: SetupConfig = {}) => {
  const socketPath = config.socketPath ?? makeSocketPath();
  const events: string[] = [];
  const exec = vi.fn(config.exec ?? okExec);
  const manual = createManualTimers();
  let nextPid = 1000;
  const spawn = vi.fn((_file: string, _args: readonly string[]) => {
    const index = children.length;
    const childOptions = typeof config.child === 'function' ? config.child(index) : (config.child ?? {});
    events.push(`spawn:${nextPid}`);
    const child = new FakeChild(nextPid, socketPath, childOptions, events);
    nextPid += 1;
    children.push(child);
    return child;
  });
  const warnings: string[] = [];
  const server: ManagedServer = createManagedServer({
    description: { ...FM_SERVER, restart: { backoffMs: BACKOFF_MS, maxRestarts: config.maxRestarts ?? 3, windowMs: RESET_MS } },
    target: 'fm',
    lockPath: `${socketPath}.lock`,
    readyTimeoutMs: HEALTH_MS,
    readStopGraceMs: config.readStopGraceMs ?? (() => GRACE_MS),
    binary: '/usr/bin/fm',
    socketPath,
    exec,
    spawn,
    timers: manual.timers,
    onWarning: (message) => warnings.push(message),
    ...(config.markerDirectory === undefined ? {} : { markerDirectory: config.markerDirectory }),
    ...(config.role === undefined ? {} : { role: config.role }),
  });
  cleanups.push(async () => {
    await server.stop();
    expect(warnings).toEqual([]);
  });
  return { server, spawn, exec, socketPath, events, manual, warnings };
};

const failingLicense = (state: { failing: boolean }) => async (_file: string, args: readonly string[]): Promise<ExecResult> =>
  state.failing && args[0] === 'license'
    ? { exitCode: 69, stdout: '', stderr: 'The license agreement has not been accepted.' }
    : { exitCode: 0, stdout: '', stderr: '' };

describe('createManagedServer preconditions', () => {
  it('reports precondition_failed with the sudo fm license remediation when the license status exits 69', async () => {
    const exec = async (_file: string, args: readonly string[]): Promise<ExecResult> =>
      args[0] === 'license'
        ? { exitCode: 69, stdout: '', stderr: 'The license agreement has not been accepted.' }
        : { exitCode: 0, stdout: '', stderr: '' };
    const { server, spawn, exec: execMock } = setup({ exec });
    await expect(server.start()).rejects.toMatchObject({ name: 'PreconditionFailedError' });
    expect(spawn).not.toHaveBeenCalled();
    expect(execMock).toHaveBeenCalledWith('/usr/bin/fm', ['license', '--status'], { signal: expect.any(AbortSignal) });
    const health = await server.health(asking());
    expect(health.ok).toBe(false);
    expect(health.reason).toBe('precondition_failed');
    expect(health.remediation).toBe('sudo fm license');
  });

  it('reports precondition_failed with fm output as detail when fm available fails', async () => {
    const exec = async (_file: string, args: readonly string[]): Promise<ExecResult> =>
      args[0] === 'available'
        ? { exitCode: 1, stdout: 'Apple Intelligence is not enabled on this device.', stderr: '' }
        : { exitCode: 0, stdout: '', stderr: '' };
    const { server, spawn, exec: execMock } = setup({ exec });
    await expect(server.start()).rejects.toMatchObject({ name: 'PreconditionFailedError' });
    expect(spawn).not.toHaveBeenCalled();
    expect(execMock).toHaveBeenCalledWith('/usr/bin/fm', ['available'], { signal: expect.any(AbortSignal) });
    const health = await server.health(asking());
    expect(health.ok).toBe(false);
    expect(health.reason).toBe('precondition_failed');
    expect(health.detail).toContain('Apple Intelligence is not enabled on this device.');
    expect(health.remediation).toBeUndefined();
  });

  it('reports idle-ok before start when preconditions hold', async () => {
    const { server, spawn } = setup();
    expect(await server.health(asking())).toMatchObject({ ok: true });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('reuses a met verdict with no clock (rule C1): health checks after any time run no precondition while the child runs', async () => {
    const { server, exec, manual } = setup();
    await server.start();
    const afterStart = exec.mock.calls.length;
    expect(await server.health(asking())).toEqual({ ok: true });
    manual.advance(60_000);
    expect(await server.health(asking())).toEqual({ ok: true });
    expect(exec.mock.calls.length).toBe(afterStart);
  });

  it('invalidates the cached preconditions when the child exits unexpectedly', async () => {
    const { server, exec } = setup();
    await server.start();
    const afterStart = exec.mock.calls.length;
    await server.health(asking());
    expect(exec.mock.calls.length).toBe(afterStart);
    await children[0]?.crash(1, null);
    await server.health(asking());
    expect(exec.mock.calls.length).toBe(afterStart + 2);
  });
});

describe('createManagedServer a child that exits while its health body is being read', () => {
  const serveHealthThenExit = async (socketPath: string, exit: () => Promise<void>): Promise<net.Server> => {
    const server = net.createServer((socket) => {
      socket.on('error', () => undefined);
      socket.once('data', () => {
        socket.write('HTTP/1.1 200 OK\r\ncontent-length: 4\r\n\r\nok');
        void exit().then(() => socket.end('ok'));
      });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, () => resolve()));
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    return server;
  };

  it('never reports running for a start whose child has exited', async () => {
    const { server, spawn, socketPath } = setup({ child: { manualServe: true } });
    const starting = server.start();
    const outcome = starting.then(
      () => 'started',
      () => 'failed',
    );
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1));
    await serveHealthThenExit(socketPath, async () => {
      await children[0]?.crash(1, null);
    });
    expect(await outcome).toBe('failed');
    expect((await server.health(asking())).ok).toBe(false);
  });
});

describe('createManagedServer start', () => {
  it('spawns fm serve with exactly the socket argv and resolves only after the socket serves /health', async () => {
    const { server, spawn, socketPath, events } = setup({ child: { manualServe: true } });
    let resolved = false;
    const starting = server.start().then((endpoint) => {
      resolved = true;
      events.push('resolved');
      return endpoint;
    });
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1));
    expect(resolved).toBe(false);
    await children[0]?.serveNow();
    expect(await starting).toEqual({ kind: 'unix', path: socketPath });
    expect(spawn).toHaveBeenCalledWith('/usr/bin/fm', ['serve', '--socket', socketPath]);
    expect(events).toEqual(['spawn:1000', 'serving:1000', 'resolved']);
    expect(await server.health(asking())).toEqual({ ok: true });
  });

  it('terminates the child with SIGTERM when start fails as unhealthy, and a retried start spawns exactly one new child', async () => {
    const { server, spawn, manual } = setup({
      child: (index) => (index === 0 ? { healthy: false } : {}),
    });
    await Promise.all([
      expect(server.start()).rejects.toMatchObject({ reason: 'unhealthy' }),
      (async () => {
        await vi.waitFor(() => expect(children[0]).toBeDefined());
        await vi.waitFor(() => expect(manual.delays()).toContain(HEALTH_MS));
        manual.fire(HEALTH_MS);
      })(),
    ]);
    expect(children[0]?.signals).toEqual(['SIGTERM']);
    expect(children[0]?.alive).toBe(false);
    expect(await server.health(asking())).toMatchObject({ ok: false, reason: 'unhealthy' });
    expect(spawn).toHaveBeenCalledTimes(1);
    await server.start();
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(await server.health(asking())).toEqual({ ok: true });
  });

  it('escalates to SIGKILL when the child ignores SIGTERM after a failed start', async () => {
    const { server, spawn, manual } = setup({
      child: (index) => (index === 0 ? { healthy: false, ignoreSigterm: true } : {}),
    });
    await Promise.all([
      expect(server.start()).rejects.toMatchObject({ reason: 'unhealthy' }),
      (async () => {
        await vi.waitFor(() => expect(children[0]).toBeDefined());
        await vi.waitFor(() => expect(manual.delays()).toContain(HEALTH_MS));
        manual.fire(HEALTH_MS);
        await vi.waitFor(() => expect(manual.delays()).toContain(GRACE_MS));
        manual.fire(GRACE_MS);
      })(),
    ]);
    expect(children[0]?.signals).toEqual(['SIGTERM', 'SIGKILL']);
    await server.start();
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it('rejects with unhealthy and terminates the child when it never opens the socket', async () => {
    const { server, manual } = setup({ child: { serve: false } });
    await Promise.all([
      expect(server.start()).rejects.toMatchObject({ reason: 'unhealthy' }),
      (async () => {
        await vi.waitFor(() => expect(children[0]).toBeDefined());
        await vi.waitFor(() => expect(manual.delays()).toContain(HEALTH_MS));
        manual.fire(HEALTH_MS);
      })(),
    ]);
    expect(children[0]?.signals).toEqual(['SIGTERM']);
  });

  it('rejects with not_running when the child emits an error event such as ENOENT', async () => {
    const failure = Object.assign(new Error('spawn /usr/bin/fm ENOENT'), { code: 'ENOENT' });
    const { server, spawn } = setup({ child: (index) => (index === 0 ? { errorOnSpawn: failure } : {}) });
    await expect(server.start()).rejects.toMatchObject({
      name: 'ManagedServerError',
      reason: 'not_running',
      message: 'the model "fm": the server could not be run: spawn /usr/bin/fm ENOENT',
    });
    expect(await server.health(asking())).toMatchObject({ ok: false, reason: 'not_running' });
    await server.start();
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it('joins concurrent start calls onto a single spawn, each asker with its own answer', async () => {
    const { server, spawn, socketPath } = setup();
    const first = server.start();
    const second = server.start();
    expect(await Promise.all([first, second])).toEqual([
      { kind: 'unix', path: socketPath },
      { kind: 'unix', path: socketPath },
    ]);
    expect(spawn).toHaveBeenCalledTimes(1);
    await expect(server.start()).rejects.toThrow(/already started/);
  });

  it('terminates the child and rejects start when stop is called while the child is still becoming healthy', async () => {
    const { server, spawn } = setup({ child: { manualServe: true } });
    const starting = server.start();
    await Promise.all([
      expect(starting).rejects.toMatchObject({ reason: 'not_running' }),
      (async () => {
        await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1));
        await server.stop();
      })(),
    ]);
    expect(children[0]?.signals).toEqual(['SIGTERM']);
    expect(await server.health(asking())).toMatchObject({ ok: false, reason: 'not_running' });
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('does not spawn when stop is called while the preconditions are still running', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { server, spawn } = setup({
      exec: async () => {
        await gate;
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    });
    const starting = server.start();
    await Promise.all([
      expect(starting).rejects.toMatchObject({ reason: 'not_running' }),
      (async () => {
        const stopping = server.stop();
        release();
        await stopping;
      })(),
    ]);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('keeps a start issued while a stop is still settling usable', async () => {
    const { server, spawn } = setup({ child: (index) => (index === 0 ? { manualServe: true } : {}) });
    await Promise.all([
      expect(server.start()).rejects.toMatchObject({ reason: 'not_running' }),
      (async () => {
        await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1));
        const stopping = server.stop();
        const second = server.start();
        await stopping;
        await second;
      })(),
    ]);
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(await server.health(asking())).toEqual({ ok: true });
  });

  it('can be started again after stop', async () => {
    const { server, spawn } = setup();
    await server.start();
    await server.stop();
    await server.start();
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(await server.health(asking())).toEqual({ ok: true });
  });
});

describe('createManagedServer socket ownership', () => {
  it('waits for a live server that owns the socket path without the instance lock only until the start deadline, then ends unhealthy with no launch and leaves that socket (items 12 and 18; section 18, item 7)', async () => {
    const socketPath = makeSocketPath();
    const owner = await startFakeChatCompletions({ scenario: 'tools-ok', socketPath });
    cleanups.push(() => owner.close());
    const { server, spawn, manual } = setup({ socketPath });
    const outcome = server.start(asking()).then(
      () => undefined,
      (error: unknown) => error,
    );
    await vi.waitFor(() => expect(manual.delays()).toContain(HEALTH_MS));
    manual.fire(HEALTH_MS);
    expect(await outcome).toMatchObject({
      name: 'ManagedServerError',
      reason: 'unhealthy',
      message: `the model "fm": the server was not ready within ${HEALTH_MS} ms of its start; readyTimeoutMs of the model in the settings sets this bound`,
    });
    expect(spawn).not.toHaveBeenCalled();
    expect(fs.statSync(socketPath).isSocket()).toBe(true);
  });

  it('removes a dead socket left on the path before spawning', async () => {
    const socketPath = makeSocketPath();
    const script = `require('node:net').createServer().listen(${JSON.stringify(socketPath)}, () => process.kill(process.pid, 'SIGKILL'))`;
    spawnSync(process.execPath, ['-e', script]);
    expect(fs.statSync(socketPath).isSocket()).toBe(true);
    const { server } = setup({ socketPath });
    await server.start();
    expect(await server.health(asking())).toEqual({ ok: true });
  });

  it('rejects start as unhealthy without touching a path that is not a socket', async () => {
    const socketPath = makeSocketPath();
    fs.writeFileSync(socketPath, 'keep me');
    const { server, spawn } = setup({ socketPath });
    await expect(server.start()).rejects.toMatchObject({
      reason: 'unhealthy',
      detail: expect.stringContaining('not a socket'),
    });
    expect(spawn).not.toHaveBeenCalled();
    expect(fs.readFileSync(socketPath, 'utf8')).toBe('keep me');
  });
});

describe('createManagedServer restarts', () => {
  it('schedules no restart for a child that exits while its gateway is retiring, and starts it again for a call that needs it (design-update 18.1.5, 20.55)', async () => {
    let role: GenerationRole = 'serving';
    const { server, spawn, manual, socketPath } = setup({ role: { current: () => role } });
    await server.start();
    role = 'retiring';

    await children[0]?.crash(1, null);
    await vi.waitFor(async () => expect(await server.health(asking())).toEqual({ ok: true, detail: 'idle; starts on demand' }));
    expect(manual.delays()).not.toContain(BACKOFF_MS);
    expect(spawn).toHaveBeenCalledTimes(1);

    expect(await server.ensureRunning()).toEqual({ kind: 'unix', path: socketPath });
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it('drops a restart that was scheduled before its gateway became retiring', async () => {
    let role: GenerationRole = 'serving';
    const { server, spawn, manual } = setup({ role: { current: () => role } });
    await server.start();
    await children[0]?.crash(1, null);
    await vi.waitFor(() => expect(manual.delays()).toEqual([BACKOFF_MS]));

    role = 'retiring';
    manual.fire(BACKOFF_MS);

    expect(await server.health(asking())).toEqual({ ok: true, detail: 'idle; starts on demand' });
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('restarts the child after the backoff following an unexpected exit and counts restarts', async () => {
    const { server, spawn, manual } = setup();
    await server.start();
    expect(server.restarts).toBe(0);
    await children[0]?.crash(1, null);
    await vi.waitFor(() => expect(manual.delays()).toEqual([BACKOFF_MS]));
    expect(spawn).toHaveBeenCalledTimes(1);
    manual.fire(BACKOFF_MS);
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2));
    expect(server.restarts).toBe(1);
    await vi.waitFor(async () => expect(await server.health(asking())).toEqual({ ok: true }));
  });

  it('doubles the backoff on each failed restart and stops at maxRestarts with an unhealthy state', async () => {
    const { server, spawn, manual } = setup({
      maxRestarts: 2,
      child: (index) => (index === 0 ? {} : { dieOnSpawn: true }),
    });
    await server.start();
    await children[0]?.crash(1, null);
    await vi.waitFor(() => expect(manual.delays()).toEqual([BACKOFF_MS]));
    manual.fire(BACKOFF_MS);
    await vi.waitFor(() => expect(manual.delays()).toEqual([BACKOFF_MS * 2]));
    manual.fire(BACKOFF_MS * 2);
    await vi.waitFor(async () =>
      expect(await server.health(asking())).toMatchObject({ ok: false, reason: 'unhealthy', detail: expect.stringContaining('2 restarts') }),
    );
    expect(manual.delays()).toEqual([]);
    expect(manual.scheduled.filter((ms) => ms !== HEALTH_MS)).toEqual([BACKOFF_MS, BACKOFF_MS * 2]);
    expect(spawn).toHaveBeenCalledTimes(3);
    expect(server.restarts).toBe(2);
  });

  it('counts a spawn error of a restarted child as a failed restart', async () => {
    const failure = new Error('spawn EACCES');
    const { server, spawn, manual } = setup({
      maxRestarts: 2,
      child: (index) => (index === 1 ? { errorOnSpawn: failure } : {}),
    });
    await server.start();
    await children[0]?.crash(1, null);
    await vi.waitFor(() => expect(manual.delays()).toEqual([BACKOFF_MS]));
    manual.fire(BACKOFF_MS);
    await vi.waitFor(() => expect(manual.delays()).toEqual([BACKOFF_MS * 2]));
    manual.fire(BACKOFF_MS * 2);
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(3));
    await vi.waitFor(async () => expect(await server.health(asking())).toEqual({ ok: true }));
    expect(server.restarts).toBe(2);
  });

  it('health-checks a restarted child and terminates one that never becomes healthy', async () => {
    const { server, manual } = setup({
      maxRestarts: 1,
      child: (index) => (index === 1 ? { healthy: false } : {}),
    });
    await server.start();
    await children[0]?.crash(1, null);
    await vi.waitFor(() => expect(manual.delays()).toEqual([BACKOFF_MS]));
    manual.fire(BACKOFF_MS);
    await vi.waitFor(() => expect(children[1]).toBeDefined());
    await vi.waitFor(() => expect(manual.delays()).toContain(HEALTH_MS));
    manual.fire(HEALTH_MS);
    await vi.waitFor(() => expect(children[1]?.signals).toEqual(['SIGTERM']));
    await vi.waitFor(async () => expect(await server.health(asking())).toMatchObject({ ok: false, reason: 'unhealthy' }));
  });

  it('re-runs the preconditions before restarting and surfaces a failure without restarting again', async () => {
    const license = { failing: false };
    const { server, spawn, manual } = setup({ exec: failingLicense(license) });
    await server.start();
    license.failing = true;
    await children[0]?.crash(1, null);
    await vi.waitFor(() => expect(manual.delays()).toEqual([BACKOFF_MS]));
    manual.fire(BACKOFF_MS);
    await vi.waitFor(async () =>
      expect(await server.health(asking())).toMatchObject({ ok: false, reason: 'precondition_failed', remediation: 'sudo fm license' }),
    );
    expect(spawn).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(manual.delays()).toEqual([]));
    license.failing = false;
    manual.advance(1000);
    expect(await server.health(asking())).toMatchObject({ ok: false, reason: 'not_running' });
    expect(spawn).toHaveBeenCalledTimes(1);
  });
});

describe('createManagedServer restart edge cases', () => {
  it('does not spawn when stop is called while the socket path is being claimed for a restart', async () => {
    const { server, spawn, manual } = setup();
    await server.start();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = fs.promises.lstat.bind(fs.promises);
    const lstat = vi.spyOn(fs.promises, 'lstat').mockImplementationOnce(async (...args: Parameters<typeof original>) => {
      await gate;
      return original(...args);
    });
    cleanups.push(async () => lstat.mockRestore());
    await children[0]?.crash(1, null);
    await vi.waitFor(() => expect(manual.delays()).toEqual([BACKOFF_MS]));
    manual.fire(BACKOFF_MS);
    await vi.waitFor(() => expect(lstat).toHaveBeenCalledTimes(1));
    const stopping = server.stop();
    release();
    await stopping;
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('closes the client when a restart ends in a precondition failure and creates a fresh one on the next start', async () => {
    const closes = vi.spyOn(Agent.prototype, 'close');
    cleanups.push(async () => closes.mockRestore());
    const license = { failing: false };
    const { server, manual } = setup({ exec: failingLicense(license) });
    await server.start();
    license.failing = true;
    await children[0]?.crash(1, null);
    await vi.waitFor(() => expect(manual.delays()).toEqual([BACKOFF_MS]));
    manual.fire(BACKOFF_MS);
    await vi.waitFor(() => expect(closedAgents(closes)).toBe(1));
    license.failing = false;
    await server.start();
    expect(closedAgents(closes)).toBe(1);
    expect(await server.health(asking())).toEqual({ ok: true });
    await server.stop();
    expect(closedAgents(closes)).toBe(2);
  });

  it('closes the client when restarts are exhausted', async () => {
    const closes = vi.spyOn(Agent.prototype, 'close');
    cleanups.push(async () => closes.mockRestore());
    const { server, manual } = setup({ maxRestarts: 1, child: (index) => (index === 0 ? {} : { dieOnSpawn: true }) });
    await server.start();
    await children[0]?.crash(1, null);
    await vi.waitFor(() => expect(manual.delays()).toEqual([BACKOFF_MS]));
    manual.fire(BACKOFF_MS);
    await vi.waitFor(() => expect(closedAgents(closes)).toBe(1));
  });

  it('closes a client left open by a failed state when start is called again', async () => {
    const closes = vi.spyOn(Agent.prototype, 'close');
    cleanups.push(async () => closes.mockRestore());
    const { server } = setup({ maxRestarts: 0 });
    await server.start();
    await children[0]?.crash(1, null);
    await vi.waitFor(async () => expect(await server.health(asking())).toMatchObject({ ok: false, reason: 'unhealthy' }));
    expect(closedAgents(closes)).toBe(0);
    await server.start();
    expect(closedAgents(closes)).toBe(1);
    expect(await server.health(asking())).toEqual({ ok: true });
  });

  it('keeps the backoff growing when the restarted child is not stable for restartResetMs', async () => {
    const { server, manual } = setup({ maxRestarts: 2 });
    await server.start();
    await children[0]?.crash(1, null);
    await vi.waitFor(() => expect(manual.delays()).toEqual([BACKOFF_MS]));
    manual.fire(BACKOFF_MS);
    await vi.waitFor(() => expect(manual.delays()).toEqual([RESET_MS]));
    await children[1]?.crash(1, null);
    await vi.waitFor(() => expect(manual.delays()).toEqual([BACKOFF_MS * 2]));
    manual.fire(BACKOFF_MS * 2);
    await vi.waitFor(() => expect(manual.delays()).toEqual([RESET_MS]));
    await children[2]?.crash(1, null);
    await vi.waitFor(async () => expect(await server.health(asking())).toMatchObject({ ok: false, reason: 'unhealthy' }));
    expect(server.restarts).toBe(2);
  });

  it('resets the backoff after the restarted child stays up for restartResetMs while restarts stays monotonic', async () => {
    const { server, spawn, manual } = setup({ maxRestarts: 2 });
    await server.start();
    await children[0]?.crash(1, null);
    await vi.waitFor(() => expect(manual.delays()).toEqual([BACKOFF_MS]));
    manual.fire(BACKOFF_MS);
    await vi.waitFor(() => expect(manual.delays()).toEqual([RESET_MS]));
    manual.fire(RESET_MS);
    await children[1]?.crash(1, null);
    await vi.waitFor(() => expect(manual.delays()).toEqual([BACKOFF_MS]));
    manual.fire(BACKOFF_MS);
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(3));
    await vi.waitFor(() => expect(manual.delays()).toEqual([RESET_MS]));
    expect(server.restarts).toBe(2);
    manual.fire(RESET_MS);
    await children[2]?.crash(1, null);
    await vi.waitFor(() => expect(manual.delays()).toEqual([BACKOFF_MS]));
    expect(await server.health(asking())).toMatchObject({ ok: false, reason: 'not_running' });
    expect(server.restarts).toBe(2);
  });
});

describe('createManagedServer injected timers', () => {
  it('routes the health poll and the health deadline through the injected timers', async () => {
    const { server, manual } = setup({ child: { manualServe: true } });
    const starting = server.start();
    await vi.waitFor(() => expect(children[0]).toBeDefined());
    await vi.waitFor(() => expect(manual.scheduled).toContain(HEALTH_MS));
    await children[0]?.serveNow();
    await starting;
    expect(manual.delays()).toEqual([]);
  });
});

describe('createManagedServer stop and health', () => {
  it('leaves no pending timer behind after a successful health check', async () => {
    const { server, manual } = setup();
    await server.start();
    expect(await server.health(asking())).toEqual({ ok: true });
    expect(manual.delays()).toEqual([]);
  });

  it('stops with SIGTERM, cancels a pending restart and does not restart', async () => {
    const { server, spawn, manual } = setup();
    await server.start();
    await children[0]?.crash(1, null);
    await vi.waitFor(() => expect(manual.delays()).toEqual([BACKOFF_MS]));
    await server.stop();
    expect(manual.delays()).toEqual([]);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(server.restarts).toBe(0);
    expect(await server.health(asking())).toMatchObject({ ok: false, reason: 'not_running' });
  });

  it('sends SIGTERM to a running child on stop', async () => {
    const { server, spawn } = setup();
    await server.start();
    await server.stop();
    expect(children[0]?.signals).toEqual(['SIGTERM']);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(await server.health(asking())).toMatchObject({ ok: false, reason: 'not_running' });
  });

  it('escalates to SIGKILL after stopGraceMs when SIGTERM is ignored', async () => {
    const { server, manual } = setup({ child: { ignoreSigterm: true } });
    await server.start();
    const stopping = server.stop();
    await vi.waitFor(() => expect(manual.delays()).toEqual([GRACE_MS]));
    expect(children[0]?.signals).toEqual(['SIGTERM']);
    manual.fire(GRACE_MS);
    await stopping;
    expect(children[0]?.signals).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('bounds health by the caller signal when the server accepts connections but never replies, with no timer of its own (design 8.3, wait 6)', async () => {
    const { server, manual } = setup();
    await server.start();
    await children[0]?.replaceServerWithSilentOne();
    const caller = new AbortController();
    const checking = server.health(caller.signal);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(manual.delays()).toEqual([]);
    const ended = new Error('the caller ended');
    caller.abort(ended);
    const answer = await checking.catch((error: unknown) => error);
    expect(answer === ended || (answer as { ok?: boolean }).ok === false).toBe(true);
  });
});

describe('createManagedServer ensureRunning', () => {
  it('starts once for concurrent callers and returns the endpoint without spawning when running', async () => {
    const { server, spawn, socketPath } = setup();
    const [first, second] = await Promise.all([server.ensureRunning(), server.ensureRunning()]);
    expect(first).toEqual({ kind: 'unix', path: socketPath });
    expect(second).toEqual(first);
    expect(await server.ensureRunning()).toEqual(first);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('starts again after the restart budget is exhausted', async () => {
    const { server, spawn, manual } = setup({
      maxRestarts: 2,
      child: (index) => (index === 0 || index >= 3 ? {} : { dieOnSpawn: true }),
    });
    await server.ensureRunning();
    await children[0]?.crash(1, null);
    await vi.waitFor(() => expect(manual.delays()).toEqual([BACKOFF_MS]));
    manual.fire(BACKOFF_MS);
    await vi.waitFor(() => expect(manual.delays()).toEqual([BACKOFF_MS * 2]));
    manual.fire(BACKOFF_MS * 2);
    await vi.waitFor(async () => expect(await server.health(asking())).toMatchObject({ ok: false, reason: 'unhealthy' }));
    await server.ensureRunning();
    expect(spawn).toHaveBeenCalledTimes(4);
    expect(await server.health(asking())).toEqual({ ok: true });
  });

  it('returns the endpoint while a restart is pending', async () => {
    const { server, spawn, socketPath } = setup();
    await server.ensureRunning();
    await children[0]?.crash(1, null);
    expect(await server.ensureRunning()).toEqual({ kind: 'unix', path: socketPath });
    expect(spawn).toHaveBeenCalledTimes(1);
  });
});

describe('createManagedServer stopped', () => {
  it('does not restart through ensureRunning after stop', async () => {
    const { server, spawn } = setup();
    await server.ensureRunning();
    await server.stop();
    await expect(server.ensureRunning()).rejects.toMatchObject({ reason: 'not_running' });
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('lets an explicit start leave the stopped state', async () => {
    const { server, spawn } = setup();
    await server.ensureRunning();
    await server.stop();
    await server.start();
    expect(spawn).toHaveBeenCalledTimes(2);
  });
});

describe('createManagedServer idle health', () => {
  it('reports ok while idle with passing preconditions', async () => {
    const { server, spawn } = setup();
    expect(await server.health(asking())).toEqual({ ok: true, detail: 'idle; starts on demand' });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('still surfaces a precondition failure while idle', async () => {
    const exec = async (_file: string, args: readonly string[]): Promise<ExecResult> =>
      args[0] === 'license' ? { exitCode: 69, stdout: '', stderr: 'no' } : { exitCode: 0, stdout: '', stderr: '' };
    const { server } = setup({ exec });
    expect(await server.health(asking())).toMatchObject({ ok: false, reason: 'precondition_failed', remediation: 'sudo fm license' });
  });

  it('reports not_running after stop', async () => {
    const { server } = setup();
    await server.ensureRunning();
    await server.stop();
    expect(await server.health(asking())).toMatchObject({ ok: false, reason: 'not_running' });
  });
});

const hangingOn =
  (hungCommand: string, signals: AbortSignal[]) =>
  (_file: string, args: readonly string[], options?: ExecOptions): Promise<ExecResult> => {
    if (args[0] !== hungCommand) return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
    if (options === undefined) return new Promise<ExecResult>(() => undefined);
    signals.push(options.signal);
    return new Promise<ExecResult>((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })));
    });
  };

describe('createManagedServer bounds each precondition command by the asking operation (design 8.2, row healthTimeoutMs (a))', () => {
  it.each(['license', 'available'])('cancels a hanging %s command when its only asker ends, with no clock of its own, and the asker leaves with its own reason', async (hungCommand) => {
    const signals: AbortSignal[] = [];
    const { server, spawn, manual } = setup({ exec: hangingOn(hungCommand, signals) });
    const asker = new AbortController();
    const starting = server.start(asker.signal).catch((error: unknown) => error);
    await vi.waitFor(() => expect(signals).toHaveLength(1));
    expect(manual.delays()).toEqual([]);
    expect(signals[0]?.aborted).toBe(false);
    const reason = new Error('the request ended');
    asker.abort(reason);
    expect(await starting).toBe(reason);
    await vi.waitFor(() => expect(signals[0]?.aborted).toBe(true));
    expect(spawn).not.toHaveBeenCalled();
  });

  it('clears the limit timer when the command finishes in time', async () => {
    const { server, manual } = setup();
    expect(await server.health(asking())).toMatchObject({ ok: true });
    expect(manual.delays()).toEqual([]);
  });
});

describe('createManagedServer confirms its SIGKILL in its own window K = KILL_CONFIRM_MS, not the grace (design 2.4, point 1)', () => {
  const started: Array<Pick<ReturnType<typeof setup>, 'server' | 'manual' | 'warnings'>> = [];

  afterEach(async () => {
    for (const { server, manual, warnings } of started.splice(0)) {
      const stopped = server.stop();
      await vi.waitFor(() => {
        for (const delay of manual.delays()) manual.fire(delay);
        expect(manual.delays()).toEqual([]);
      });
      await stopped;
      warnings.splice(0);
    }
  });

  it.each([GRACE_MS, 0])('stop grace %i: the wait after SIGKILL is K; a child that outlives it is reported and the stop resolves', async (stopGraceMs) => {
    const { server, manual, warnings } = setup({ child: { ignoreSigterm: true, ignoreSigkill: true } });
    started.push({ server, manual, warnings });
    await server.start();
    const stopping = server.stop({ stopGraceMs });
    await vi.waitFor(() => expect(manual.delays()).toEqual([stopGraceMs]));
    manual.fire(stopGraceMs);
    await vi.waitFor(() => expect(children[0]?.signals).toEqual(['SIGTERM', 'SIGKILL']));
    await vi.waitFor(() => expect(manual.delays()).toEqual([KILL_CONFIRM_MS]));
    manual.fire(KILL_CONFIRM_MS);
    await stopping;
    expect(warnings).toEqual([`the model "fm": the server process was not confirmed stopped: it did not exit within ${KILL_CONFIRM_MS} ms after SIGKILL`]);
    warnings.splice(0);
    expect(children[0]?.alive).toBe(true);
  });

  it.each([GRACE_MS, 0])('stop grace %i: a child that ends inside the window after SIGKILL is confirmed stopped with no warning', async (stopGraceMs) => {
    const { server, manual, warnings } = setup({ child: { ignoreSigterm: true, ignoreSigkill: true } });
    started.push({ server, manual, warnings });
    await server.start();
    const stopping = server.stop({ stopGraceMs });
    await vi.waitFor(() => expect(manual.delays()).toEqual([stopGraceMs]));
    manual.fire(stopGraceMs);
    await vi.waitFor(() => expect(children[0]?.signals).toEqual(['SIGTERM', 'SIGKILL']));
    await vi.waitFor(() => expect(manual.delays()).toEqual([KILL_CONFIRM_MS]));
    await children[0]?.crash(null, 'SIGKILL');
    await stopping;
    expect(warnings).toEqual([]);
    expect(manual.delays()).toEqual([]);
  });
});

describe('createManagedServer stops with the stop grace of the stop that asks', () => {
  it('a stop grace of 0 sends SIGKILL right after SIGTERM and never waits the configured grace', async () => {
    const { server, manual } = setup({ child: { ignoreSigterm: true } });
    await server.start();
    const stopping = server.stop({ stopGraceMs: 0 });
    await vi.waitFor(() => {
      if (manual.delays().includes(0)) manual.fire(0);
      expect(children[0]?.signals).toEqual(['SIGTERM', 'SIGKILL']);
    });
    expect(manual.delays()).not.toContain(GRACE_MS);
    if (manual.delays().includes(0)) manual.fire(0);
    await stopping;
  });
});

describe('createManagedServer stops begun outside a close read the stop grace at their begin (design 3.2)', () => {
  const FILE_GRACE_MS = 70;

  it('terminates a child after a failed start with the grace read at that stop begin, not the configured default', async () => {
    let reads = 0;
    const { server, manual } = setup({
      child: (index) => (index === 0 ? { healthy: false, ignoreSigterm: true } : {}),
      readStopGraceMs: () => {
        reads += 1;
        return FILE_GRACE_MS;
      },
    });
    await Promise.all([
      expect(server.start()).rejects.toMatchObject({ reason: 'unhealthy' }),
      (async () => {
        await vi.waitFor(() => expect(children[0]).toBeDefined());
        await vi.waitFor(() => expect(manual.delays()).toContain(HEALTH_MS));
        manual.fire(HEALTH_MS);
        await vi.waitFor(() => expect(manual.delays()).toContain(FILE_GRACE_MS));
        expect(manual.delays()).not.toContain(GRACE_MS);
        expect(reads).toBe(1);
        manual.fire(FILE_GRACE_MS);
      })(),
    ]);
    expect(children[0]?.signals).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('reads the grace when the start-up reap of stale groups begins', async () => {
    const markerDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-markers-'));
    dirs.push(markerDirectory);
    let reads = 0;
    const { server } = setup({
      markerDirectory,
      child: { manualServe: true },
      readStopGraceMs: () => {
        reads += 1;
        return FILE_GRACE_MS;
      },
    });
    const starting = server.start();
    await vi.waitFor(() => expect(children[0]).toBeDefined());
    expect(reads).toBe(1);
    await children[0]?.serveNow();
    await starting;
  });
});
