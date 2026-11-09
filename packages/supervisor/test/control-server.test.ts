import { spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ProcessLockHeldError, listenUnix, momongaPaths, parseReadyLine, inspectProcessLock } from '@momonga/foundation';
import type { SupervisorHealth } from '@momonga/protocol';
import { LSOF_PATH, REAL_PROCESS_TEST_TIMEOUT_MS, createFakeClock, createFakeTimers, registerCleanup, spawnTracked, waitFor, withTempDir, firstGeneration, realProcessTestSignal } from '@momonga/testkit';
import type { CleanupContext } from '@momonga/testkit';
import { createControlRequestHandler, respondShutdown, startControlServer } from '../src/control-server.ts';
import type { ControlServer } from '../src/control-server.ts';
import { trackSupervisorChildren } from './support/track-supervisor-children.ts';
import { createRealWorkScope, httpOver, phaseChanges, pumpUntil, quiesce, settledFlag, startHarness, writeMarker } from './fixtures/p3-harness.ts';

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const SAMPLE_HEALTH: SupervisorHealth = {
  status: 'ok',
  version: '9.9.9-test',
  apiVersion: 1,
  pid: process.pid,
  startedAt: '2026-01-01T00:00:00.000Z',
  phase: 'running',
  env: 'frozen at supervisor start',
  children: [
    { role: 'gateway', state: 'ready', pid: 11, startedAt: '2026-01-01T00:00:01.000Z', readyAt: '2026-01-01T00:00:02.000Z', restarts: 0, consecutiveFailures: 0 },
    { role: 'runtime', state: 'backoff', restarts: 1, consecutiveFailures: 1, nextAttemptAt: '2026-01-01T00:00:03.000Z' },
  ],
  logs: { droppedLines: 0 },
};

const header = (headers: Readonly<Record<string, string | number>>, name: string): string | number | undefined =>
  Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];

describe('respondShutdown', () => {
  it('shutdown writes the 202 and then starts the drain without waiting for the response to be delivered', () => {
    const calls: string[] = [];
    let status = 0;
    let headers: Readonly<Record<string, string | number>> = {};
    let body = '';
    let requested = 0;
    respondShutdown(
      {
        writeHead: (code, values) => {
          calls.push('writeHead');
          status = code;
          headers = values;
        },
        end: (text) => {
          calls.push('end');
          body = text;
        },
      },
      () => {
        calls.push('requested');
        requested += 1;
      },
    );
    expect(calls).toEqual(['writeHead', 'end', 'requested']);
    expect(status).toBe(202);
    expect(String(header(headers, 'connection')).toLowerCase()).toBe('close');
    expect(String(header(headers, 'content-type'))).toMatch(/^application\/json/);
    expect(JSON.parse(body)).toEqual({ phase: 'draining' });
    expect(requested).toBe(1);
  });

});

const runDir = (context: CleanupContext): string => {
  const dir = path.join(withTempDir(context), 'run');
  fs.mkdirSync(dir, { mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  return dir;
};

const startServer = async (
  context: CleanupContext,
  health: () => SupervisorHealth = () => SAMPLE_HEALTH,
) => {
  const socketPath = path.join(runDir(context), 'supervisor.sock');
  const clock = createFakeClock(0);
  const timers = createFakeTimers(clock);
  const realWork = createRealWorkScope();
  let shutdowns = 0;
  const errors: Error[] = [];
  const server: ControlServer = await realWork.run(() => startControlServer({
    socketPath,
    timers,
    health,
    credential: () => ({ kind: 'refused' }),
    onShutdownRequested: () => {
      shutdowns += 1;
    },
    onError: (error) => void errors.push(error),
  }));
  registerCleanup(context, async () => {
    const closing = settledFlag(server.close());
    await pumpUntil(timers, () => closing.settled(), { realWork, maxMs: 50_000, description: 'the control server to close' });
  });
  return { socketPath, server, timers, realWork, shutdowns: () => shutdowns, errors };
};

const envelopeOf = (text: string): unknown => JSON.parse(text);

describe('startControlServer', () => {
  it('GET /v1/health answers the health snapshot', async (context) => {
    const { socketPath } = await startServer(context);
    const response = await httpOver(context, socketPath, 'GET', '/v1/health');
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/^application\/json/);
    expect(JSON.parse(response.text)).toEqual(SAMPLE_HEALTH);
  });

  it('HEAD health, query string, trailing slash', async (context) => {
    const { socketPath } = await startServer(context);
    const head = await httpOver(context, socketPath, 'HEAD', '/v1/health');
    expect(head.status).toBe(200);
    expect(head.text).toBe('');
    expect(head.headers['content-type']).toMatch(/^application\/json/);
    expect((await httpOver(context, socketPath, 'GET', '/v1/health?x=1')).status).toBe(200);
    const trailing = await httpOver(context, socketPath, 'GET', '/v1/health/');
    expect(trailing.status).toBe(404);
  });

  it('unknown path 404, wrong method 405, and error bodies are ErrorEnvelope', async (context) => {
    const { socketPath } = await startServer(context);
    const missing = await httpOver(context, socketPath, 'GET', '/v1/nothing');
    expect(missing.status).toBe(404);
    expect(envelopeOf(missing.text)).toEqual({ error: { message: expect.any(String), type: 'not_found', param: null, code: 'not_found' } });
    const postHealth = await httpOver(context, socketPath, 'POST', '/v1/health', '{}');
    expect(postHealth.status).toBe(405);
    expect(postHealth.headers['allow']).toBe('GET, HEAD');
    expect(envelopeOf(postHealth.text)).toEqual({ error: { message: expect.any(String), type: 'invalid_request', param: null, code: 'method_not_allowed' } });
    const getShutdown = await httpOver(context, socketPath, 'GET', '/v1/shutdown');
    expect(getShutdown.status).toBe(405);
    expect(getShutdown.headers['allow']).toBe('POST');
    expect(envelopeOf(getShutdown.text)).toMatchObject({ error: { code: 'method_not_allowed' } });
  });

  it('shutdown request body', async (context) => {
    const server = await startServer(context);
    const small = await httpOver(context, server.socketPath, 'POST', '/v1/shutdown', 'x'.repeat(100));
    expect(small.status).toBe(202);
    expect(small.headers['connection']).toBe('close');
    expect(JSON.parse(small.text)).toEqual({ phase: 'draining' });
    await waitFor(() => server.shutdowns() === 1, { description: 'shutdown requested after the 202' });
    const large = await httpOver(context, server.socketPath, 'POST', '/v1/shutdown', 'x'.repeat(2048));
    expect(large.status).toBe(413);
    expect(envelopeOf(large.text)).toEqual({ error: { message: expect.any(String), type: 'invalid_request', param: null, code: 'payload_too_large' } });
    await quiesce(server.realWork);
    expect(server.shutdowns()).toBe(1);
  });

  it('a client that disconnects right after POST /v1/shutdown still starts the drain', async (context) => {
    const server = await startServer(context);
    const raw = net.connect(server.socketPath);
    registerCleanup(context, () => void raw.destroy());
    raw.on('error', () => undefined);
    await new Promise<void>((resolve) => raw.once('connect', () => resolve()));
    raw.write('POST /v1/shutdown HTTP/1.1\r\nHost: localhost\r\nContent-Length: 0\r\n\r\n');
    raw.destroy();
    await waitFor(() => server.shutdowns() > 0, { description: 'drain requested after the client vanished', maxTurns: 20_000 });
    await quiesce(server.realWork);
    expect(server.shutdowns()).toBe(1);
  });

  it('every POST /v1/shutdown is answered 202', async (context) => {
    const server = await startServer(context);
    expect((await httpOver(context, server.socketPath, 'POST', '/v1/shutdown')).status).toBe(202);
    expect((await httpOver(context, server.socketPath, 'POST', '/v1/shutdown')).status).toBe(202);
    await waitFor(() => server.shutdowns() === 2);
  });

  it('no longer routes /v1/shutdown-if-idle', async (context) => {
    const server = await startServer(context);
    expect((await httpOver(context, server.socketPath, 'POST', '/v1/shutdown-if-idle')).status).toBe(404);
    await quiesce(server.realWork);
    expect(server.shutdowns()).toBe(0);
  });

  it('socket mode is 0600 and the directory 0700', async (context) => {
    const { socketPath } = await startServer(context);
    expect(fs.statSync(socketPath).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(socketPath)).mode & 0o777).toBe(0o700);
    expect(fs.statSync(socketPath).isSocket()).toBe(true);
  });

  it('second supervisor on the same socket', async (context) => {
    const { socketPath } = await startServer(context);
    const clock = createFakeClock(0);
    const second = startControlServer({
      socketPath,
      timers: createFakeTimers(clock),
      health: () => SAMPLE_HEALTH,
      credential: () => ({ kind: 'refused' }),
      onShutdownRequested: () => undefined,
      onError: () => undefined,
    });
    const error = await second.then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ProcessLockHeldError);
    expect((error as ProcessLockHeldError).lockPath).toBe(`${socketPath}.lock`);
  });

  it('close removes the socket and releases its lock', async (context) => {
    const { socketPath, server, timers, realWork } = await startServer(context);
    expect(await inspectProcessLock(`${socketPath}.lock`)).toEqual({ state: 'held', pid: process.pid });
    const closing = settledFlag(server.close());
    await pumpUntil(timers, () => closing.settled(), { realWork, maxMs: 5000 });
    expect(fs.existsSync(socketPath)).toBe(false);
    expect(await inspectProcessLock(`${socketPath}.lock`)).toEqual({ state: 'free' });
  });

  it('step 5 with a half-sent request completes within the bound', async (context) => {
    const { socketPath, server, timers, realWork, shutdowns } = await startServer(context);
    const raw = net.connect(socketPath);
    registerCleanup(context, () => void raw.destroy());
    raw.on('error', () => undefined);
    await new Promise<void>((resolve) => raw.once('connect', () => resolve()));
    raw.write('POST /v1/shutdown HTTP/1.1\r\nHost: localhost\r\nContent-Length: 100\r\n\r\nabc');
    await quiesce(realWork);
    const closing = settledFlag(server.close());
    await quiesce(realWork);
    await pumpUntil(timers, () => closing.settled(), { realWork, maxMs: 1000 });
    expect(fs.existsSync(socketPath)).toBe(false);
    expect(await inspectProcessLock(`${socketPath}.lock`)).toEqual({ state: 'free' });
    expect(shutdowns()).toBe(0);
  });

  it('negative control: server.close alone is held by a half-sent request', async (context) => {
    const socketPath = path.join(runDir(context), 'control.sock');
    const server = http.createServer(() => undefined);
    await listenUnix(server, socketPath, undefined, realProcessTestSignal());
    const raw = net.connect(socketPath);
    raw.on('error', () => undefined);
    await new Promise<void>((resolve) => raw.once('connect', () => resolve()));
    const requested = new Promise<void>((resolve) => server.once('request', () => resolve()));
    raw.write('POST /v1/shutdown HTTP/1.1\r\nHost: localhost\r\nContent-Length: 100\r\n\r\nabc');
    await requested;
    let closed = false;
    server.close(() => {
      closed = true;
    });
    server.closeIdleConnections();
    const open = await new Promise<number>((resolve, reject) => {
      server.getConnections((error, count) => (error === null ? resolve(count) : reject(error)));
    });
    expect(open).toBe(1);
    expect(closed).toBe(false);
    server.closeAllConnections();
    await waitFor(() => closed, { description: 'close after closeAllConnections' });
    raw.destroy();
    expect(await inspectProcessLock(`${socketPath}.lock`)).toEqual({ state: 'free' });
  });
});

describe('control API through the supervisor', () => {
  it('health shape', async (context) => {
    const h = await startHarness(context);
    await h.waitForState('runtime', 'ready');
    await h.waitForState('gateway', 'ready');
    const response = await httpOver(context, firstGeneration(h.paths).sockets.supervisor, 'GET', '/v1/health');
    expect(response.status).toBe(200);
    const body = JSON.parse(response.text) as Record<string, unknown> & SupervisorHealth;
    expect(body).not.toHaveProperty('state');
    expect(Object.keys(body).sort()).toEqual(['apiVersion', 'children', 'env', 'logs', 'phase', 'pid', 'startedAt', 'status', 'version']);
    expect(body).toMatchObject({ status: 'ok', version: '9.9.9-test', apiVersion: 1, pid: process.pid, phase: 'running', env: 'frozen at supervisor start', logs: { droppedLines: 0 } });
    expect(body.startedAt).toMatch(ISO);
    expect(body.children.map((child) => child.role)).toEqual(['gateway', 'runtime']);
    for (const child of body.children) {
      expect(child.state).toBe('ready');
      expect(child.startedAt).toMatch(ISO);
      expect(child.readyAt).toMatch(ISO);
      expect(child.pid).toBe(h.fake.latest(child.role).pid);
      expect(child).toMatchObject({ restarts: 0, consecutiveFailures: 0 });
    }
  });

  it('health carries env: frozen at supervisor start', async (context) => {
    const h = await startHarness(context);
    expect(h.health().env).toBe('frozen at supervisor start');
    expect(JSON.parse((await httpOver(context, firstGeneration(h.paths).sockets.supervisor, 'GET', '/v1/health')).text)).toMatchObject({ env: 'frozen at supervisor start' });
  });

  it('health reflects the state machine', async (context) => {
    const h = await startHarness(context);
    await h.waitForState('runtime', 'ready');
    await h.waitForState('gateway', 'ready');
    const exitAt = h.clock.now();
    h.fake.latest('runtime').exit(1);
    const gateway = h.fake.latest('gateway');
    gateway.writeStderr('sandbox-exec is missing');
    gateway.exit(78);
    await waitFor(() => h.child('runtime').state === 'backoff' && h.child('gateway').state === 'held-config', { description: 'backoff and held-config' });
    const runtime = h.child('runtime');
    expect(runtime.nextAttemptAt).toBe(new Date(exitAt + 250).toISOString());
    expect(runtime.lastExit).toMatchObject({ code: 1, signal: null, reason: 'failure' });
    expect(runtime.consecutiveFailures).toBe(1);
    expect(h.child('gateway').heldReason).toBe('child exited 78: sandbox-exec is missing');
    const wire = JSON.parse((await httpOver(context, firstGeneration(h.paths).sockets.supervisor, 'GET', '/v1/health')).text) as SupervisorHealth;
    expect(wire.children[1]?.nextAttemptAt).toBe(runtime.nextAttemptAt);
    expect(wire.children[0]?.heldReason).toBe('child exited 78: sandbox-exec is missing');
  });

  it('health during the reap', async (context) => {
    const h = await startHarness(context, {
      prepare: (_home, paths) => void writeMarker(paths, 'runtime-old'),
      markerPorts: { findHolders: async () => [999_999] },
    });
    await waitFor(() => h.markers.calls.findHolders.length > 0, { description: 'phase 1 polling' });
    const response = await httpOver(context, firstGeneration(h.paths).sockets.supervisor, 'GET', '/v1/health');
    expect(response.status).toBe(200);
    const body = JSON.parse(response.text) as SupervisorHealth;
    expect(body.phase).toBe('reaping-orphans');
    expect(body.children).toEqual([
      { role: 'gateway', state: 'pending', restarts: 0, consecutiveFailures: 0 },
      { role: 'runtime', state: 'pending', restarts: 0, consecutiveFailures: 0 },
    ]);
    expect(h.fake.spawnCount()).toBe(0);
  });

  it('phase transitions are one way', async (context) => {
    const h = await startHarness(context);
    const observed: string[] = [h.health().phase];
    const observe = (): void => {
      const phase = h.health().phase;
      if (observed.at(-1) !== phase) observed.push(phase);
    };
    await pumpUntil(h.timers, () => (observe(), h.health().phase === 'running'), { realWork: h.realWork, maxMs: 5000 });
    const closing = settledFlag(h.supervisor.close());
    await pumpUntil(h.timers, () => (observe(), closing.settled()), { realWork: h.realWork, maxMs: 120_000 });
    expect(observed).toEqual(['reaping-orphans', 'running', 'draining']);
    expect(phaseChanges(h.log)).toEqual(['reaping-orphans->running', 'running->draining']);
  });

  it('a shutdown begun in reaping-orphans goes directly to draining', async (context) => {
    const h = await startHarness(context, {
      prepare: (_home, paths) => void writeMarker(paths, 'runtime-old'),
      markerPorts: { findHolders: async () => [999_999] },
    });
    await waitFor(() => h.markers.calls.findHolders.length > 0);
    const response = await httpOver(context, firstGeneration(h.paths).sockets.supervisor, 'POST', '/v1/shutdown');
    expect(response.status).toBe(202);
    expect(JSON.parse(response.text)).toEqual({ phase: 'draining' });
    await waitFor(() => h.health().phase === 'draining', { description: 'draining after the 202' });
    expect(h.health().children.map((child) => child.state)).toEqual(['stopped', 'stopped']);
    const result = await (async () => {
      const closed = settledFlag(h.supervisor.closed);
      await pumpUntil(h.timers, () => closed.settled(), { realWork: h.realWork, maxMs: 30_000 });
      return closed.value();
    })();
    expect(result).toEqual({ clean: true, killed: [], leaked: [] });
    expect(h.fake.spawnCount()).toBe(0);
    expect(phaseChanges(h.log)).toEqual(['reaping-orphans->draining']);
  });

  it('onShutdownRequested absent: the callback starts close()', async (context) => {
    const h = await startHarness(context);
    await h.waitForState('runtime', 'ready');
    await h.waitForState('gateway', 'ready');
    const closed = settledFlag(h.supervisor.closed);
    expect((await httpOver(context, firstGeneration(h.paths).sockets.supervisor, 'POST', '/v1/shutdown')).status).toBe(202);
    await pumpUntil(h.timers, () => closed.settled(), { realWork: h.realWork, maxMs: 120_000 });
    expect(closed.value()).toEqual({ clean: true, killed: [], leaked: [] });
    expect(h.fake.latest('runtime').signals).toEqual(['SIGTERM']);
    expect(h.fake.latest('gateway').signals).toEqual(['SIGTERM']);
  });

  it('onShutdownRequested present: the drain is left to the caller', async (context) => {
    let requested = 0;
    const h = await startHarness(context, { overrides: { onShutdownRequested: () => void (requested += 1) } });
    await h.waitForState('runtime', 'ready');
    expect((await httpOver(context, firstGeneration(h.paths).sockets.supervisor, 'POST', '/v1/shutdown')).status).toBe(202);
    await waitFor(() => requested === 1);
    await quiesce(h.realWork);
    expect(h.fake.latest('runtime').signals).toEqual([]);
  });

  it('shutdown twice', async (context) => {
    const h = await startHarness(context);
    await h.waitForState('runtime', 'ready');
    await h.waitForState('gateway', 'ready');
    h.fake.setBehaviour('runtime', { onTerm: 'ignore' });
    expect((await httpOver(context, firstGeneration(h.paths).sockets.supervisor, 'POST', '/v1/shutdown')).status).toBe(202);
    await waitFor(() => h.fake.latest('runtime').signals.length === 1);
    expect((await httpOver(context, firstGeneration(h.paths).sockets.supervisor, 'POST', '/v1/shutdown')).status).toBe(202);
    await quiesce(h.realWork);
    expect(h.log.withMsg('shutdown.begin')).toHaveLength(1);
    expect(h.fake.latest('runtime').signals).toEqual(['SIGTERM']);
    h.fake.latest('runtime').exit(0);
    const closed = settledFlag(h.supervisor.closed);
    await pumpUntil(h.timers, () => closed.settled(), { realWork: h.realWork, maxMs: 120_000 });
    expect(h.fake.latest('gateway').signals).toEqual(['SIGTERM']);
  });

  it('health during draining', async (context) => {
    const h = await startHarness(context);
    await h.waitForState('runtime', 'ready');
    h.fake.setBehaviour('runtime', { onTerm: 'ignore' });
    expect((await httpOver(context, firstGeneration(h.paths).sockets.supervisor, 'POST', '/v1/shutdown')).status).toBe(202);
    await waitFor(() => h.fake.latest('runtime').signals.length === 1);
    const response = await httpOver(context, firstGeneration(h.paths).sockets.supervisor, 'GET', '/v1/health');
    expect(response.status).toBe(200);
    const body = JSON.parse(response.text) as SupervisorHealth;
    expect(body.phase).toBe('draining');
    expect(body.children[1]?.state).toBe('stopping');
  });
});

const SUPERVISOR_FIXTURE = fileURLToPath(new URL('./fixtures/p2-supervisor-fixture.ts', import.meta.url));
const CHILD_FIXTURE = fileURLToPath(new URL('./fixtures/p2-child.ts', import.meta.url));
const TCP_LISTENER_FIXTURE = fileURLToPath(new URL('./fixtures/p3b-tcp-listener.ts', import.meta.url));

type ListenProbe = { status: number | null; stdout: string; stderr: string; names: string[] };

const probeTcpListeners = (pid: number): ListenProbe => {
  const run = spawnSync(LSOF_PATH, ['-a', '-p', String(pid), '-i', 'TCP', '-sTCP:LISTEN', '-n', '-P', '-Fn'], { encoding: 'utf8' });
  const names = run.stdout
    .split('\n')
    .filter((line) => line.startsWith('n'))
    .map((line) => line.slice(1));
  return { status: run.status, stdout: run.stdout, stderr: run.stderr, names };
};

const firstStdoutLine = (child: ChildProcess, predicate: (line: string) => boolean, description: string): Promise<string> =>
  new Promise((resolve, reject) => {
    let buffered = '';
    let errors = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      errors += chunk.toString();
    });
    child.stdout?.on('data', (chunk: Buffer) => {
      buffered += chunk.toString();
      const line = buffered.split('\n').find((candidate) => predicate(candidate));
      if (line !== undefined) resolve(line);
    });
    child.once('exit', (code, signal) => reject(new Error(`${description}: exited ${String(code)} ${String(signal)} before the line: ${errors}`)));
  });

describe('control API transport', { timeout: REAL_PROCESS_TEST_TIMEOUT_MS }, () => {
  it('no TCP listener', async (context) => {
    const listener = spawnTracked(context, process.execPath, [TCP_LISTENER_FIXTURE], { stdio: ['ignore', 'pipe', 'pipe'] });
    const listening = JSON.parse(await firstStdoutLine(listener, (line) => line.includes('"listening"'), 'tcp listener')) as { listening: number };
    expect(listening.listening).toBeGreaterThan(0);
    const control = probeTcpListeners(listener.pid as number);
    expect(control.stderr).toBe('');
    expect(control.status).toBe(0);
    expect(control.names).toEqual([`127.0.0.1:${listening.listening}`]);

    const home = withTempDir(context, { asHome: true });
    const paths = momongaPaths(home, process.platform, {});
    const supervisor = spawnTracked(context, process.execPath, [SUPERVISOR_FIXTURE, `--home=${home}`, `--child=${CHILD_FIXTURE}`], { stdio: ['ignore', 'pipe', 'pipe'] });
    trackSupervisorChildren(context, firstGeneration(paths).sockets.supervisor);
    const ready = parseReadyLine(await firstStdoutLine(supervisor, (line) => parseReadyLine(line) !== undefined, 'fixture supervisor'));
    expect(ready).toMatchObject({ service: 'supervisor', pid: supervisor.pid, socketPath: firstGeneration(paths).sockets.supervisor });
    const probe = probeTcpListeners(supervisor.pid as number);
    expect(probe.stderr).toBe('');
    expect([0, 1]).toContain(probe.status);
    if (probe.status === 1) expect(probe.stdout).toBe('');
    expect(probe.names).toEqual([]);
  });
});
