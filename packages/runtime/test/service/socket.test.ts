import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createUdsClient, fixedSocket } from '@momonga/foundation';
import { createFakeClock } from '@momonga/testkit';
import { START_MS, createFakePorts, createNotifier, launchService, makeLayout, onCleanup, openStore, sendJson, serviceOptions, startService, pollFor } from './helpers.ts';
import type { Layout } from './helpers.ts';

const attempt = async (layout: Layout, socketPath: string, home = layout.home) => {
  const clock = createFakeClock(START_MS);
  const notifier = createNotifier();
  const store = openStore(layout.dbPath, clock, { notifier });
  const options = serviceOptions({ store, clock, home, socketPath, ports: createFakePorts(), notifier, errors: [] });
  const service = await launchService(options);
  onCleanup(() => service.close());
  return service;
};

describe('run service socket', () => {
  it('creates the socket with mode 0600 and serves over it', async () => {
    const env = await startService();
    const stat = fs.lstatSync(env.layout.socketPath);
    expect(stat.isSocket()).toBe(true);
    expect(stat.mode & 0o777).toBe(0o600);
    expect(env.service.socketPath).toBe(env.layout.socketPath);
    expect((await env.http('GET', '/v1/health')).status).toBe(200);
  });

  it('refuses a socket directory that is a symlink', async () => {
    const layout = makeLayout();
    const real = path.join(layout.momonga, 'real');
    fs.mkdirSync(real, { mode: 0o700 });
    fs.chmodSync(real, 0o700);
    const link = path.join(layout.momonga, 'link');
    fs.symlinkSync(real, link, 'dir');
    const socketPath = path.join(link, 'r.sock');

    await expect(attempt(layout, socketPath)).rejects.toThrow(/symlink/i);
    expect(fs.existsSync(path.join(real, 'r.sock'))).toBe(false);
  });

  it('refuses a socket directory whose mode is not 0700', async () => {
    const layout = makeLayout();
    fs.chmodSync(layout.runDir, 0o755);
    await expect(attempt(layout, layout.socketPath)).rejects.toThrow(/0700|mode/);
    expect(fs.existsSync(layout.socketPath)).toBe(false);
  });

  it('refuses a socket outside <home>/.momonga/', async () => {
    const layout = makeLayout();
    const outside = path.join(layout.root, 'x');
    fs.mkdirSync(outside, { mode: 0o700 });
    fs.chmodSync(outside, 0o700);
    await expect(attempt(layout, path.join(outside, 'r.sock'))).rejects.toThrow(/\.momonga/);
    expect(fs.existsSync(path.join(outside, 'r.sock'))).toBe(false);
  });

  it('refuses a sibling directory that only shares the .momonga prefix', async () => {
    const layout = makeLayout();
    const sibling = path.join(layout.home, '.momonga-x');
    fs.mkdirSync(sibling, { mode: 0o700 });
    fs.chmodSync(sibling, 0o700);
    await expect(attempt(layout, path.join(sibling, 'r.sock'))).rejects.toThrow(/\.momonga/);
    expect(fs.existsSync(path.join(sibling, 'r.sock'))).toBe(false);
  });

  it('compares by realpath, so a symlinked home still accepts its own .momonga tree', async () => {
    const layout = makeLayout();
    const linkedHome = path.join(layout.root, 'hl');
    fs.symlinkSync(layout.home, linkedHome, 'dir');
    const service = await attempt(layout, layout.socketPath, linkedHome);
    const client = createUdsClient(fixedSocket(service.socketPath));
    onCleanup(() => client.close());
    expect((await sendJson(client, 'GET', '/v1/health')).status).toBe(200);
  });

  it('removes the socket file and ends open streams on close', async () => {
    const env = await startService();
    const session = await env.createSession();
    const run = await env.createRun(session.id);
    const stream = await env.stream(`/v1/runs/${run.id}/events`);
    await pollFor(() => env.notifier.subscriberCount() === 1, 5000, 'the subscriber to register');

    await env.closeService();

    expect(fs.existsSync(env.layout.socketPath)).toBe(false);
    await pollFor(() => stream.ended, 5000, 'the open stream to end');
    expect(env.notifier.subscriberCount()).toBe(0);
    const fresh = createUdsClient(fixedSocket(env.layout.socketPath));
    onCleanup(() => fresh.close());
    await expect(fresh.request({ method: 'GET', path: '/v1/health' })).rejects.toThrow();
  });
});
