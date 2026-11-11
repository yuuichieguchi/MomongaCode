import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createManagedTarget } from '@momonga/gateway';
import type { ManagedServer } from '@momonga/gateway';
import type { KnownProbeKey } from '@momonga/config';
import { REAL_PROCESS_TEST_TIMEOUT_MS } from '@momonga/testkit';
import { memoizedVerification } from '../../src/probe/endpoint-target.ts';
import { NO_AUTO_PROBE, fmRecordKey, fmModelBase, primed, recordKeyOptions } from '../fm-record-support.ts';
import { makeDir } from '../gateway-helpers.ts';
import { FakeChild, SERVER_KINDS, createManagedServer, createManualTimers, makeShortDir } from './managed-support.ts';
import type { ManagedServerHandle } from './managed-support.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const dirs: string[] = [];
const children: FakeChild[] = [];
const servers: ManagedServerHandle[] = [];
const listeners: http.Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop().catch(() => undefined);
  for (const child of children.splice(0)) await child.crash(0, null);
  for (const listener of listeners.splice(0)) {
    listener.closeAllConnections();
    await new Promise<void>((resolve) => listener.close(() => resolve()));
  }
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const asking = (): AbortSignal => new AbortController().signal;

describe.each(SERVER_KINDS)('a start of $label shared by several askers runs under its own signal (gateway-accounts-04)', (kind) => {
  const setup = () => {
    const dir = makeShortDir(dirs);
    const socket = path.join(dir, `${kind.target}.sock`);
    const spawned: FakeChild[] = [];
    const server = createManagedServer({
      description: kind.description(),
      target: kind.target,
      binary: '/opt/managed/bin/server',
      socketPath: socket,
      lockPath: path.join(dir, `${kind.target}.lock`),
      readyTimeoutMs: 400,
      exec: kind.metExec,
      spawn: () => {
        const created = new FakeChild(socket, kind.readyPath, { manualServe: true });
        spawned.push(created);
        children.push(created);
        return created;
      },
      timers: createManualTimers().timers,
      readStopGraceMs: () => 30,
      onWarning: () => undefined,
    });
    servers.push(server);
    return { server, spawned, socket };
  };

  it('two askers on one start: the first leaves by its own signal, the second gets the server from the same child', async () => {
    const { server, spawned, socket } = setup();
    const first = new AbortController();
    const reason = new Error('the first request ended');
    const left = server.start(first.signal).catch((error: unknown) => error);
    const staying = server.start(asking());
    await vi.waitFor(() => expect(spawned).toHaveLength(1));
    first.abort(reason);
    expect(await left).toBe(reason);
    await spawned[0]?.serveNow();
    expect(await staying).toEqual({ kind: 'unix', path: socket });
    expect(spawned).toHaveLength(1);
    expect(spawned[0]?.alive).toBe(true);
  });

  it('both askers leave: the child is stopped, and a later start launches a new one', async () => {
    const { server, spawned, socket } = setup();
    const first = new AbortController();
    const second = new AbortController();
    const starts = [server.start(first.signal).catch((error: unknown) => error), server.start(second.signal).catch((error: unknown) => error)];
    await vi.waitFor(() => expect(spawned).toHaveLength(1));
    first.abort(new Error('the first request ended'));
    expect(spawned[0]?.alive).toBe(true);
    second.abort(new Error('the second request ended'));
    await Promise.all(starts);
    await vi.waitFor(() => expect(spawned[0]?.alive).toBe(false));
    const again = server.start(asking());
    await vi.waitFor(() => expect(spawned).toHaveLength(2));
    await spawned[1]?.serveNow();
    expect(await again).toEqual({ kind: 'unix', path: socket });
  });
});

describe('the model listing of a managed target shared by several askers runs under its own signal', () => {
  it('the first asker leaves while the listing is read: the second gets the listed id from the one read', async () => {
    const socketPath = path.join(makeShortDir(dirs), 'listing.sock');
    let listings = 0;
    let answer = (): void => undefined;
    const reached = new Promise<void>((resolve) => {
      const listener = http.createServer((_request, response) => {
        listings += 1;
        answer = () => {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ data: [{ id: 'listed-by-the-server' }] }));
        };
        resolve();
      });
      listeners.push(listener);
      listener.listen(socketPath);
    });
    const fmServe: ManagedServer = {
      restarts: 0,
      start: async () => ({ kind: 'unix', path: socketPath }),
      ensureRunning: async () => ({ kind: 'unix', path: socketPath }),
      stop: async () => undefined,
      health: async () => ({ ok: true }),
    };
    const recordKey: KnownProbeKey = fmRecordKey('ab'.repeat(32), '25A100');
    const probeRecordDir = makeDir();
    const target = await primed(
      createManagedTarget({
        ...fmModelBase(),
        server: fmServe,
        binary: '/usr/bin/fm',
        exec: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
        probeRecordDir,
        ...recordKeyOptions(recordKey, NO_AUTO_PROBE),
        toolCallingSetting: 'native',
        declaredCapabilities: { contextWindow: 8192, maxOutputTokens: 1024 },
      }),
      'fm',
    );
    const named = { name: 'fm', display: 'fm', model: 'label' };
    const first = new AbortController();
    const reason = new Error('the first request ended');
    const left = target.upstreamModel(named, first.signal).catch((error: unknown) => error);
    const staying = target.upstreamModel(named, asking());
    await reached;
    first.abort(reason);
    expect(await left).toBe(reason);
    answer();
    expect(await staying).toBe('listed-by-the-server');
    expect(listings).toBe(1);
  });
});

describe('a verification shared by several askers runs under its own signal and is kept once it passed', () => {
  it('the first asker leaves: the second gets the result of the one verification; a later asker starts none', async () => {
    let runs = 0;
    let pass = (): void => undefined;
    const seen: AbortSignal[] = [];
    const verify = memoizedVerification((signal) => {
      runs += 1;
      seen.push(signal);
      return new Promise<void>((resolve, reject) => {
        pass = resolve;
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    });
    const first = new AbortController();
    const reason = new Error('the first request ended');
    const left = verify(first.signal).catch((error: unknown) => error);
    const staying = verify(asking());
    first.abort(reason);
    expect(await left).toBe(reason);
    expect(seen[0]?.aborted).toBe(false);
    pass();
    await staying;
    await verify(asking());
    expect(runs).toBe(1);
  });

  it('every asker leaves: the verification is stopped, and the next asker starts a new one', async () => {
    const seen: AbortSignal[] = [];
    const verify = memoizedVerification((signal) => {
      seen.push(signal);
      return new Promise<void>((resolve, reject) => {
        if (seen.length === 2) resolve();
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    });
    const only = new AbortController();
    const left = verify(only.signal).catch((error: unknown) => error);
    only.abort(new Error('the request ended'));
    await left;
    expect(seen[0]?.aborted).toBe(true);
    await verify(asking());
    expect(seen).toHaveLength(2);
  });

  it('a failed verification is not kept: the next asker verifies again', async () => {
    let runs = 0;
    const verify = memoizedVerification(async () => {
      runs += 1;
      if (runs === 1) throw new Error('the server is not the one recorded');
    });
    await expect(verify(asking())).rejects.toThrow('the server is not the one recorded');
    await verify(asking());
    expect(runs).toBe(2);
  });
});
