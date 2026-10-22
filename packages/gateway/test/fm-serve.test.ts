import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Agent } from 'undici';
import { createFmServe, type ExecResult, type FmServe, type FmServeTimers } from '@momonga/gateway';
import { startFakeChatCompletions, type FakeChatCompletionsServer } from '@momonga/testkit';

interface FakeChildOptions {
  manualServe?: boolean;
  healthy?: boolean;
  serve?: boolean;
  ignoreSigterm?: boolean;
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

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.signals.push(signal);
    if (signal === 'SIGTERM' && this.options.ignoreSigterm === true) return true;
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
  const timers: FmServeTimers = {
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
  exec?: (file: string, args: readonly string[]) => Promise<ExecResult>;
  maxRestarts?: number;
  preconditionTtlMs?: number;
  socketPath?: string;
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
  const server: FmServe = createFmServe({
    binary: '/usr/bin/fm',
    socketPath,
    exec,
    spawn,
    timers: manual.timers,
    healthTimeoutMs: HEALTH_MS,
    restartBackoffMs: BACKOFF_MS,
    stopGraceMs: GRACE_MS,
    maxRestarts: config.maxRestarts ?? 3,
    restartResetMs: RESET_MS,
    preconditionTtlMs: config.preconditionTtlMs ?? 1000,
  });
  cleanups.push(() => server.stop());
  return { server, spawn, exec, socketPath, events, manual };
};

const failingLicense = (state: { failing: boolean }) => async (_file: string, args: readonly string[]): Promise<ExecResult> =>
  state.failing && args[0] === 'license'
    ? { exitCode: 69, stdout: '', stderr: 'The license agreement has not been accepted.' }
    : { exitCode: 0, stdout: '', stderr: '' };

describe('createFmServe preconditions', () => {
  it('reports precondition_failed with the sudo fm license remediation when the license status exits 69', async () => {
    const exec = async (_file: string, args: readonly string[]): Promise<ExecResult> =>
      args[0] === 'license'
        ? { exitCode: 69, stdout: '', stderr: 'The license agreement has not been accepted.' }
        : { exitCode: 0, stdout: '', stderr: '' };
    const { server, spawn, exec: execMock } = setup({ exec });
    await expect(server.start()).rejects.toMatchObject({ reason: 'precondition_failed' });
    expect(spawn).not.toHaveBeenCalled();
    expect(execMock).toHaveBeenCalledWith('/usr/bin/fm', ['license', '--status']);
    const health = await server.health();
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
    await expect(server.start()).rejects.toMatchObject({ reason: 'precondition_failed' });
    expect(spawn).not.toHaveBeenCalled();
    expect(execMock).toHaveBeenCalledWith('/usr/bin/fm', ['available']);
    const health = await server.health();
    expect(health.ok).toBe(false);
    expect(health.reason).toBe('precondition_failed');
    expect(health.detail).toContain('Apple Intelligence is not enabled on this device.');
    expect(health.remediation).toBeUndefined();
  });

  it('reports not_running before start when preconditions hold', async () => {
    const { server, spawn } = setup();
    expect(await server.health()).toMatchObject({ ok: false, reason: 'not_running' });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('does not re-run the precondition commands within the ttl and does again after it expires', async () => {
    const { server, exec, manual } = setup({ preconditionTtlMs: 1000 });
    await server.start();
    const afterStart = exec.mock.calls.length;
    expect(await server.health()).toEqual({ ok: true });
    expect(await server.health()).toEqual({ ok: true });
    expect(exec.mock.calls.length).toBe(afterStart);
    manual.advance(1000);
    expect(await server.health()).toEqual({ ok: true });
    expect(exec.mock.calls.length).toBe(afterStart + 2);
  });

  it('invalidates the cached preconditions when the child exits unexpectedly', async () => {
    const { server, exec } = setup();
    await server.start();
    const afterStart = exec.mock.calls.length;
    await server.health();
    expect(exec.mock.calls.length).toBe(afterStart);
    await children[0]?.crash(1, null);
    await server.health();
    expect(exec.mock.calls.length).toBe(afterStart + 2);
  });
});

describe('createFmServe start', () => {
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
    expect(await starting).toEqual({ kind: 'unix', socketPath });
    expect(spawn).toHaveBeenCalledWith('/usr/bin/fm', ['serve', '--socket', socketPath]);
    expect(events).toEqual(['spawn:1000', 'serving:1000', 'resolved']);
    expect(await server.health()).toEqual({ ok: true });
  });

  it('terminates the child with SIGTERM when start fails as unhealthy, and a retried start spawns exactly one new child', async () => {
    const { server, spawn, manual } = setup({
      child: (index) => (index === 0 ? { healthy: false } : {}),
    });
    const rejected = expect(server.start()).rejects.toMatchObject({ reason: 'unhealthy' });
    await vi.waitFor(() => expect(manual.delays()).toContain(HEALTH_MS));
    manual.fire(HEALTH_MS);
    await rejected;
    expect(children[0]?.signals).toEqual(['SIGTERM']);
    expect(children[0]?.alive).toBe(false);
    expect(await server.health()).toMatchObject({ ok: false, reason: 'unhealthy' });
    expect(spawn).toHaveBeenCalledTimes(1);
    await server.start();
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(await server.health()).toEqual({ ok: true });
  });

  it('escalates to SIGKILL when the child ignores SIGTERM after a failed start', async () => {
    const { server, spawn, manual } = setup({
      child: (index) => (index === 0 ? { healthy: false, ignoreSigterm: true } : {}),
    });
    const rejected = expect(server.start()).rejects.toMatchObject({ reason: 'unhealthy' });
    await vi.waitFor(() => expect(manual.delays()).toContain(HEALTH_MS));
    manual.fire(HEALTH_MS);
    await vi.waitFor(() => expect(manual.delays()).toContain(GRACE_MS));
    manual.fire(GRACE_MS);
    await rejected;
    expect(children[0]?.signals).toEqual(['SIGTERM', 'SIGKILL']);
    await server.start();
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it('rejects with unhealthy and terminates the child when it never opens the socket', async () => {
    const { server, manual } = setup({ child: { serve: false } });
    const rejected = expect(server.start()).rejects.toMatchObject({ reason: 'unhealthy' });
    await vi.waitFor(() => expect(manual.delays()).toContain(HEALTH_MS));
    manual.fire(HEALTH_MS);
    await rejected;
    expect(children[0]?.signals).toEqual(['SIGTERM']);
  });

  it('rejects with not_running when the child emits an error event such as ENOENT', async () => {
    const failure = Object.assign(new Error('spawn /usr/bin/fm ENOENT'), { code: 'ENOENT' });
    const { server, spawn } = setup({ child: (index) => (index === 0 ? { errorOnSpawn: failure } : {}) });
    await expect(server.start()).rejects.toMatchObject({
      name: 'FmServeError',
      reason: 'not_running',
      detail: 'spawn /usr/bin/fm ENOENT',
    });
    expect(await server.health()).toMatchObject({ ok: false, reason: 'not_running' });
    await server.start();
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it('joins concurrent start calls onto a single spawn', async () => {
    const { server, spawn, socketPath } = setup();
    const first = server.start();
    const second = server.start();
    expect(second).toBe(first);
    expect(await first).toEqual({ kind: 'unix', socketPath });
    expect(spawn).toHaveBeenCalledTimes(1);
    await expect(server.start()).rejects.toThrow(/already started/);
  });

  it('terminates the child and rejects start when stop is called while the child is still becoming healthy', async () => {
    const { server, spawn } = setup({ child: { manualServe: true } });
    const starting = server.start();
    const rejected = expect(starting).rejects.toMatchObject({ reason: 'not_running' });
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1));
    await server.stop();
    await rejected;
    expect(children[0]?.signals).toEqual(['SIGTERM']);
    expect(await server.health()).toMatchObject({ ok: false, reason: 'not_running' });
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
    const rejected = expect(starting).rejects.toMatchObject({ reason: 'not_running' });
    const stopping = server.stop();
    release();
    await stopping;
    await rejected;
    expect(spawn).not.toHaveBeenCalled();
  });

  it('keeps a start issued while a stop is still settling usable', async () => {
    const { server, spawn } = setup({ child: (index) => (index === 0 ? { manualServe: true } : {}) });
    const first = server.start();
    const firstRejected = expect(first).rejects.toMatchObject({ reason: 'not_running' });
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1));
    const stopping = server.stop();
    const second = server.start();
    await stopping;
    await firstRejected;
    await second;
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(await server.health()).toEqual({ ok: true });
  });

  it('can be started again after stop', async () => {
    const { server, spawn } = setup();
    await server.start();
    await server.stop();
    await server.start();
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(await server.health()).toEqual({ ok: true });
  });
});

describe('createFmServe socket ownership', () => {
  it('rejects start as unhealthy when another live server owns the socket path', async () => {
    const socketPath = makeSocketPath();
    const owner = await startFakeChatCompletions({ scenario: 'tools-ok', socketPath });
    cleanups.push(() => owner.close());
    const { server, spawn } = setup({ socketPath });
    await expect(server.start()).rejects.toMatchObject({
      reason: 'unhealthy',
      detail: expect.stringContaining('another process'),
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
    expect(await server.health()).toEqual({ ok: true });
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

describe('createFmServe restarts', () => {
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
    await vi.waitFor(async () => expect(await server.health()).toEqual({ ok: true }));
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
      expect(await server.health()).toMatchObject({ ok: false, reason: 'unhealthy', detail: expect.stringContaining('2 restarts') }),
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
    await vi.waitFor(async () => expect(await server.health()).toEqual({ ok: true }));
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
    await vi.waitFor(() => expect(manual.delays()).toContain(HEALTH_MS));
    manual.fire(HEALTH_MS);
    await vi.waitFor(() => expect(children[1]?.signals).toEqual(['SIGTERM']));
    await vi.waitFor(async () => expect(await server.health()).toMatchObject({ ok: false, reason: 'unhealthy' }));
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
      expect(await server.health()).toMatchObject({ ok: false, reason: 'precondition_failed', remediation: 'sudo fm license' }),
    );
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(manual.delays()).toEqual([]);
    license.failing = false;
    manual.advance(1000);
    expect(await server.health()).toMatchObject({ ok: false, reason: 'not_running' });
    expect(spawn).toHaveBeenCalledTimes(1);
  });
});

describe('createFmServe restart edge cases', () => {
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
    expect(await server.health()).toEqual({ ok: true });
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
    await vi.waitFor(async () => expect(await server.health()).toMatchObject({ ok: false, reason: 'unhealthy' }));
    expect(closedAgents(closes)).toBe(0);
    await server.start();
    expect(closedAgents(closes)).toBe(1);
    expect(await server.health()).toEqual({ ok: true });
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
    await vi.waitFor(async () => expect(await server.health()).toMatchObject({ ok: false, reason: 'unhealthy' }));
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
    expect(await server.health()).toMatchObject({ ok: false, reason: 'not_running' });
    expect(server.restarts).toBe(2);
  });
});

describe('createFmServe injected timers', () => {
  it('routes the health poll and the health deadline through the injected timers', async () => {
    const { server, manual } = setup({ child: { manualServe: true } });
    const starting = server.start();
    await vi.waitFor(() => expect(manual.scheduled).toContain(HEALTH_MS));
    await children[0]?.serveNow();
    await starting;
    expect(manual.delays()).toEqual([]);
  });
});

describe('createFmServe stop and health', () => {
  it('leaves no pending timer behind after a successful health check', async () => {
    const { server, manual } = setup();
    await server.start();
    expect(await server.health()).toEqual({ ok: true });
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
    expect(await server.health()).toMatchObject({ ok: false, reason: 'not_running' });
  });

  it('sends SIGTERM to a running child on stop', async () => {
    const { server, spawn } = setup();
    await server.start();
    await server.stop();
    expect(children[0]?.signals).toEqual(['SIGTERM']);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(await server.health()).toMatchObject({ ok: false, reason: 'not_running' });
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

  it('bounds health by the health timeout when the server accepts connections but never replies', async () => {
    const { server, manual } = setup();
    await server.start();
    await children[0]?.replaceServerWithSilentOne();
    const checking = server.health();
    await vi.waitFor(() => expect(manual.delays()).toContain(HEALTH_MS));
    manual.fire(HEALTH_MS);
    expect(await checking).toEqual({ ok: false, reason: 'unhealthy' });
    expect(manual.delays()).toEqual([]);
  });
});
