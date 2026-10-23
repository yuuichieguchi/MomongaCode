import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createUdsClient, volumeIsCaseInsensitive } from '@momonga/foundation';
import type { RuntimeStore } from '@momonga/store';
import { createFakeClock } from '@momonga/testkit';
import { START_MS, createFakePorts, createNotifier, launchService, makeLayout, onCleanup, openStore, sendJson, serviceOptions } from './helpers.ts';
import type { Layout, RunService } from './helpers.ts';

const CASE_INSENSITIVE = volumeIsCaseInsensitive(fs.realpathSync(os.tmpdir()));

type Attempt = { socketPath?: string; home?: string; protectedRootAreas?: readonly string[]; wrapStore?: (store: RuntimeStore) => RuntimeStore };

const optionsFor = (layout: Layout, attempt: Attempt = {}): Record<string, unknown> => {
  const clock = createFakeClock(START_MS);
  const notifier = createNotifier();
  const store = openStore(layout.dbPath, clock, { notifier });
  return serviceOptions({
    store: attempt.wrapStore === undefined ? store : attempt.wrapStore(store),
    clock,
    home: attempt.home ?? layout.home,
    socketPath: attempt.socketPath ?? layout.socketPath,
    ports: createFakePorts(),
    notifier,
    errors: [],
  }, attempt.protectedRootAreas === undefined ? {} : { protectedRootAreas: attempt.protectedRootAreas });
};

const launch = async (layout: Layout, attempt: Attempt = {}): Promise<RunService> => {
  const service = await launchService(optionsFor(layout, attempt));
  onCleanup(() => service.close());
  return service;
};

const healthStatus = async (socketPath: string): Promise<number> => {
  const client = createUdsClient(socketPath);
  onCleanup(() => client.close());
  return (await sendJson(client, 'GET', '/v1/health')).status;
};

const rejectionOf = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected createRunService to reject');
};

describe('run service start (system timers)', () => {
  it('createRunService is async and listens on the socket', async () => {
    const layout = makeLayout();
    const factory = (await import('@momonga/runtime')).createRunService as unknown as (options: Record<string, unknown>) => unknown;
    const pending = factory(optionsFor(layout));
    expect(pending).toBeInstanceOf(Promise);
    const service = (await pending) as RunService;
    onCleanup(() => service.close());
    expect(service.socketPath).toBe(layout.socketPath);
    expect(fs.lstatSync(layout.socketPath).isSocket()).toBe(true);
    expect(await healthStatus(layout.socketPath)).toBe(200);
  });

  it('a socket directory that resolves outside home/.momonga is refused', async () => {
    const layout = makeLayout();
    const outside = path.join(layout.root, 'x');
    fs.mkdirSync(outside, { mode: 0o700 });
    fs.chmodSync(outside, 0o700);
    const linkDir = path.join(layout.momonga, 'out');
    fs.symlinkSync(outside, linkDir, 'dir');
    const socketPath = path.join(linkDir, 'r.sock');

    const error = await rejectionOf(launch(layout, { socketPath }));

    expect((error as Error).message).toBe(`the run socket must live under ${path.join(layout.home, '.momonga')}, but ${socketPath} resolves to ${outside}`);
    expect(fs.existsSync(path.join(outside, 'r.sock'))).toBe(false);
  });

  it('a relative home raises TypeError', async () => {
    const layout = makeLayout();
    const error = await rejectionOf(launch(layout, { home: 'relative/home', protectedRootAreas: [] }));
    expect(error).toBeInstanceOf(TypeError);
    expect(fs.existsSync(layout.socketPath)).toBe(false);
  });

  it.runIf(CASE_INSENSITIVE)('a case-variant home passes the socket-home assertion', async () => {
    const layout = makeLayout();
    const variantHome = path.join(path.dirname(layout.home), path.basename(layout.home).toUpperCase());
    const variantSocket = path.join(path.dirname(layout.home), path.basename(layout.home), '.MOMONGA', 'run', 'r.sock');
    const service = await launch(layout, { home: variantHome, socketPath: variantSocket });
    expect(service.socketPath).toBe(variantSocket);
    expect(await healthStatus(layout.socketPath)).toBe(200);
  });

  it('a symlinked home passes the socket-home assertion', async () => {
    const layout = makeLayout();
    const linkedHome = path.join(layout.root, 'hl');
    fs.symlinkSync(layout.home, linkedHome, 'dir');
    await launch(layout, { home: linkedHome });
    expect(await healthStatus(layout.socketPath)).toBe(200);
  });

  it('a failure after listen (a store whose dataVersion throws) closes the server, releases the socket lock and rethrows the original error', async () => {
    const layout = makeLayout();
    const failure = new Error('dataVersion failed at start');
    const failingStore = (store: RuntimeStore): RuntimeStore =>
      new Proxy(store, {
        get(target, property, receiver) {
          if (property === 'dataVersion') {
            return () => {
              throw failure;
            };
          }
          const value = Reflect.get(target, property, receiver);
          return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
        },
      });

    const error = await rejectionOf(launch(layout, { wrapStore: failingStore }));

    expect(error).toBe(failure);
    expect(fs.existsSync(layout.socketPath)).toBe(false);
    const probe = createUdsClient(layout.socketPath);
    onCleanup(() => probe.close());
    await expect(probe.request({ method: 'GET', path: '/v1/health' })).rejects.toThrow();

    const second = await launch(layout);
    expect(second.socketPath).toBe(layout.socketPath);
    expect(await healthStatus(layout.socketPath)).toBe(200);
  });

  it('a second service on the same socket path rejects', async () => {
    const layout = makeLayout();
    await launch(layout);
    await expect(launch(layout)).rejects.toThrow();
    expect(await healthStatus(layout.socketPath)).toBe(200);
  });
});
