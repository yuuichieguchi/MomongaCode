import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { createUdsClient, fixedSocket } from '@momonga/foundation';
import { FAKE_SERVER, FAKE_SERVER_MODEL, REAL_PROCESS_TEST_TIMEOUT_MS, createFakeManagedServer } from '@momonga/testkit';
import { FakeChild, SERVER_KINDS, createManagedServer, createManualTimers, makeShortDir } from './managed-support.ts';
import type { ExecPort, FakeChildOptions, ManagedServerHandle, ServerKind } from './managed-support.ts';

const READY_MS = 400;
const GRACE_MS = 30;
const BACKOFF_MS = 50;
const WINDOW_MS = 5_000;
const MAX_RESTARTS = 2;

const dirs: string[] = [];
const children: FakeChild[] = [];
const servers: ManagedServerHandle[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop().catch(() => undefined);
  for (const child of children.splice(0)) await child.crash(0, null);
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

type Setup = {
  kind: ServerKind;
  exec?: ExecPort;
  child?: (index: number) => FakeChildOptions;
  socketPath?: string;
  lockPath?: string;
  spawned?: FakeChild[];
};

const setup = ({ kind, exec, child, socketPath, lockPath, spawned = [] }: Setup) => {
  const dir = makeShortDir(dirs);
  const socket = socketPath ?? path.join(dir, `${kind.target}.sock`);
  const execMock = vi.fn(exec ?? kind.metExec);
  const manual = createManualTimers();
  const warnings: string[] = [];
  const spawn = vi.fn((_file: string, _args: readonly string[]) => {
    const created = new FakeChild(socket, kind.readyPath, child?.(spawned.length) ?? {});
    spawned.push(created);
    children.push(created);
    return created;
  });
  const server = createManagedServer({
    description: { ...kind.description(), restart: { backoffMs: BACKOFF_MS, maxRestarts: MAX_RESTARTS, windowMs: WINDOW_MS } },
    target: kind.target,
    binary: '/opt/managed/bin/server',
    socketPath: socket,
    lockPath: lockPath ?? path.join(dir, `${kind.target}.lock`),
    readyTimeoutMs: READY_MS,
    exec: execMock,
    spawn,
    timers: manual.timers,
    readStopGraceMs: () => GRACE_MS,
    onWarning: (message) => warnings.push(message),
  });
  servers.push(server);
  return { server, spawn, exec: execMock, manual, socket, spawned, warnings };
};

const asking = (): AbortSignal => new AbortController().signal;

describe.each(SERVER_KINDS)('one managed server mechanism, driven by the description of $label (design-managed-servers sections 3.2, 7.1, 8, 13)', (kind) => {
  it('launches the binary with the description argv, the socket substituted for {socket}, and is ready only when the description readiness route answers', async () => {
    const { server, spawn, socket } = setup({ kind });
    expect(await server.start(asking())).toEqual({ kind: 'unix', socketPath: socket });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith('/opt/managed/bin/server', kind.argvOf(socket));
  });

  it('runs the description preconditions with the asking signal and refuses with the description text and remedy, before any launch', async () => {
    const { server, spawn, exec } = setup({ kind, exec: kind.refusingExec });
    const signal = asking();
    const failure = await server.start(signal).catch((error: unknown) => error);
    expect(failure).toMatchObject({ name: 'PreconditionFailedError', message: kind.refusal.message, remediation: kind.refusal.remediation });
    expect(spawn).not.toHaveBeenCalled();
    expect(exec.mock.calls[0]?.[2]?.signal.aborted).toBe(false);
  });

  it('never reuses a refused precondition verdict (rule C1): each health check runs the preconditions again, with no clock', async () => {
    const { server, exec } = setup({ kind, exec: kind.refusingExec });
    await server.start(asking()).catch(() => undefined);
    const afterStart = exec.mock.calls.length;
    expect(await server.health(asking())).toMatchObject({ ok: false, reason: 'precondition_failed', remediation: kind.refusal.remediation });
    const afterFirst = exec.mock.calls.length;
    expect(afterFirst).toBeGreaterThan(afterStart);
    await server.health(asking());
    expect(exec.mock.calls.length).toBeGreaterThan(afterFirst);
  });

  it('starts right after a refused condition is met, with no clock advanced (rule C1 replaces the 60 s verdict cache)', async () => {
    let refusing = true;
    const exec: ExecPort = (file, args, options) => (refusing ? kind.refusingExec(file, args, options) : kind.metExec(file, args, options));
    const { server, spawn, socket } = setup({ kind, exec });
    await expect(server.start(asking())).rejects.toMatchObject({ name: 'PreconditionFailedError' });
    refusing = false;
    expect(await server.start(asking())).toEqual({ kind: 'unix', socketPath: socket });
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('reuses a met verdict only until the server next exits', async () => {
    const { server, exec, spawned } = setup({ kind });
    await server.start(asking());
    const afterStart = exec.mock.calls.length;
    await server.health(asking());
    expect(exec.mock.calls.length).toBe(afterStart);
    await spawned[0]?.crash(1, null);
    await server.health(asking());
    expect(exec.mock.calls.length).toBeGreaterThan(afterStart);
  });

  it('bounds a precondition by the asking operation only: no clock of its own, and the command is cancelled when the asker ends', async () => {
    const seen: AbortSignal[] = [];
    const hanging: ExecPort = (_file, _args, options) =>
      new Promise((_resolve, reject) => {
        seen.push(options.signal);
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
      });
    const { server, manual, spawn } = setup({ kind, exec: hanging });
    const controller = new AbortController();
    const starting = server.start(controller.signal).catch((error: unknown) => error);
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(manual.delays()).toEqual([]);
    controller.abort(new Error('the request ended'));
    await starting;
    expect(seen[0]?.aborted).toBe(true);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('bounds the readiness wait by the target readyTimeoutMs and stops a child that never becomes ready', async () => {
    const { server, manual, spawned } = setup({ kind, child: () => ({ neverReady: true }) });
    const starting = server.start(asking()).catch((error: unknown) => error);
    await vi.waitFor(() => expect(spawned).toHaveLength(1));
    await vi.waitFor(() => expect(manual.delays()).toContain(READY_MS));
    manual.fire(READY_MS);
    expect(await starting).toBeInstanceOf(Error);
    expect(spawned[0]?.signals[0]).toBe('SIGTERM');
  });

  it('restarts with the description backoff doubling, stops after maxRestarts with the English text, and the next request starts it again', async () => {
    const { server, spawn, manual, spawned } = setup({ kind, child: (index) => (index === 0 ? {} : { dieOnSpawn: true }) });
    await server.start(asking());
    await spawned[0]?.crash(1, null);
    await vi.waitFor(() => expect(manual.delays()).toEqual([BACKOFF_MS]));
    manual.fire(BACKOFF_MS);
    await vi.waitFor(() => expect(manual.delays()).toEqual([BACKOFF_MS * 2]));
    manual.fire(BACKOFF_MS * 2);
    await vi.waitFor(async () =>
      expect(await server.health(asking())).toEqual({ ok: false, reason: 'unhealthy', detail: `the target "${kind.target}": the server exceeded ${MAX_RESTARTS} restarts; the next request starts it again` }),
    );
    expect(spawn).toHaveBeenCalledTimes(1 + MAX_RESTARTS);
    expect(manual.delays()).toEqual([]);
    await server.ensureRunning(asking()).catch(() => undefined);
    expect(spawn).toHaveBeenCalledTimes(2 + MAX_RESTARTS);
  });

  it('resets the restart count after a restarted child stays up for the description window', async () => {
    const { server, manual, spawned } = setup({ kind });
    await server.start(asking());
    await spawned[0]?.crash(1, null);
    await vi.waitFor(() => expect(manual.delays()).toEqual([BACKOFF_MS]));
    manual.fire(BACKOFF_MS);
    await vi.waitFor(() => expect(manual.delays()).toEqual([WINDOW_MS]));
    manual.fire(WINDOW_MS);
    await spawned[1]?.crash(1, null);
    await vi.waitFor(() => expect(manual.delays()).toEqual([BACKOFF_MS]));
  });

  it('stops its child with SIGTERM and the grace read at the stop begin', async () => {
    const { server, spawned } = setup({ kind });
    await server.start(asking());
    await server.stop();
    expect(spawned[0]?.signals).toEqual(['SIGTERM']);
  });

  it('claims its instance with its own lock: two starters of one instance launch one child, and the other start never launches a second (item 18)', async () => {
    const dir = makeShortDir(dirs);
    const socketPath = path.join(dir, `${kind.target}.sock`);
    const lockPath = path.join(dir, `${kind.target}.lock`);
    const spawned: FakeChild[] = [];
    const first = setup({ kind, socketPath, lockPath, spawned, child: () => ({ manualServe: true }) });
    const second = setup({ kind, socketPath, lockPath, spawned, child: () => ({ manualServe: true }) });
    const starts = [first.server.start(asking()), second.server.start(asking())];
    await vi.waitFor(() => expect(spawned).toHaveLength(1));
    await spawned[0]?.serveNow();
    const outcomes = await Promise.allSettled(starts);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(spawned).toHaveLength(1);
    const refused = outcomes.find((outcome) => outcome.status === 'rejected');
    expect(refused?.status === 'rejected' ? (refused.reason as Error).message : '').toBe(`the target "${kind.target}": the server socket path is occupied`);
  });
});

describe('the second kind runs as a real process through the same mechanism (design section 13.2, item 1)', { timeout: REAL_PROCESS_TEST_TIMEOUT_MS }, () => {
  it('launches the fake server binary, waits for GET /ready, and the endpoint lists the fake model at GET /models', async () => {
    const dir = makeShortDir(dirs);
    const fake = await createFakeManagedServer({ dir });
    const markerDirectory = path.join(dir, 'markers', 'workbench');
    fs.mkdirSync(markerDirectory, { recursive: true, mode: 0o700 });
    const server = createManagedServer({
      description: FAKE_SERVER,
      target: 'workbench',
      binary: fake.binaryPath,
      socketPath: path.join(dir, 'w.sock'),
      lockPath: path.join(dir, 'w.lock'),
      markerDirectory,
      readyTimeoutMs: FAKE_SERVER.ready.limitMs,
      readStopGraceMs: () => 1_000,
      onWarning: () => undefined,
    });
    servers.push(server);
    const endpoint = await server.start(AbortSignal.timeout(REAL_PROCESS_TEST_TIMEOUT_MS));
    const client = createUdsClient(fixedSocket(endpoint.socketPath));
    try {
      const response = await client.request({ method: 'GET', path: '/models', signal: AbortSignal.timeout(REAL_PROCESS_TEST_TIMEOUT_MS) });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ models: [{ name: FAKE_SERVER_MODEL }] });
    } finally {
      await client.close();
    }
    await server.stop();
    expect(fs.readdirSync(markerDirectory)).toEqual([]);
  });
});
