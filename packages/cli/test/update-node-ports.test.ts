import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { momongaPaths } from '@momonga/foundation';
import { registerCleanup, withTempDir } from '@momonga/testkit';
import { describe, expect, it } from 'vitest';
import type { CliPorts } from '../src/ports.ts';
import { MAX_REDIRECTS, nodeDaemonProbe, nodeUpdateLock, nodeUpdatePorts, nodeUpdateState, undiciUpdateHttp } from '../src/update/node-ports.ts';
import { readyChildren, startFakeSupervisor, virtualClock } from './fake-supervisor.ts';

const unusedPort = (name: string): never =>
  new Proxy(() => undefined, {
    apply: () => {
      throw new Error(`the update test did not expect the ${name} port`);
    },
    get: () => unusedPort(name),
  }) as never;

const cliPortsFor =(home: string): CliPorts =>
  ({
    version: '1.0.0',
    env: { PATH: '/usr/bin', UNSET: undefined },
    cwd: home,
    home,
    stdout: { write: () => undefined },
    stderr: { write: () => undefined },
    clock: virtualClock(),
    random: () => 0,
    self: { kind: 'single-binary', execPath: path.join(home, 'momonga') },
    spawnDetached: () => ({ exit: new Promise(() => undefined) }),
    terminal: undefined,
    files: unusedPort('files'),
    openUrl: unusedPort('openUrl'),
    secretStore: unusedPort('secretStore'),
  }) satisfies CliPorts;

describe('autoUpdates', () => {
  it('is on by default and follows the user settings file', async (context) => {
    const home = withTempDir(context, { asHome: true });
    const ports = nodeUpdatePorts(cliPortsFor(home), momongaPaths(home));
    expect(await ports.autoUpdates()).toBe(true);

    fs.mkdirSync(path.join(home, '.momonga'), { recursive: true });
    fs.writeFileSync(path.join(home, '.momonga', 'settings.json'), JSON.stringify({ autoUpdates: false }));
    expect(await ports.autoUpdates()).toBe(false);
  });

  it('is not influenced by a project settings file in the working directory', async (context) => {
    const home = withTempDir(context, { asHome: true });
    const project = path.join(home, 'project');
    fs.mkdirSync(path.join(project, '.momonga'), { recursive: true });
    fs.writeFileSync(path.join(project, '.momonga', 'settings.json'), JSON.stringify({ autoUpdates: false }));
    const ports = nodeUpdatePorts({ ...cliPortsFor(home), cwd: project }, momongaPaths(home));

    expect(await ports.autoUpdates()).toBe(true);
  });

  it('passes only defined environment variables to child commands', async (context) => {
    const home = withTempDir(context, { asHome: true });
    expect(nodeUpdatePorts(cliPortsFor(home), momongaPaths(home)).env).toEqual({ PATH: '/usr/bin' });
  });
});

describe('update state store', () => {
  it('reads undefined before the first write and returns what was written afterwards', async (context) => {
    const home = withTempDir(context, { asHome: true });
    const store = nodeUpdateState(momongaPaths(home));
    expect(await store.read()).toBeUndefined();

    await store.write({ checkedAt: 7, outcome: { kind: 'up_to_date' }, announced: true });

    expect(await store.read()).toEqual({ checkedAt: 7, outcome: { kind: 'up_to_date' }, announced: true });
    expect(fs.readdirSync(path.join(home, '.momonga', 'state')).filter((entry) => entry.startsWith('update.json'))).toEqual(['update.json']);
  });

  it('fails on a file that is not JSON', async (context) => {
    const home = withTempDir(context, { asHome: true });
    const paths = momongaPaths(home);
    const store = nodeUpdateState(paths);
    await store.write({});
    fs.writeFileSync(path.join(paths.state, 'update.json'), '{ nope');

    await expect(store.read()).rejects.toThrow(SyntaxError);
  });
});

describe('update lock', () => {
  it('hands the lock to one holder at a time', async (context) => {
    const home = withTempDir(context, { asHome: true });
    const lock = nodeUpdateLock(momongaPaths(home));

    const first = await lock.acquire();
    expect(first).toBeDefined();
    expect(await lock.acquire()).toBeUndefined();

    first?.release();
    const again = await lock.acquire();
    expect(again).toBeDefined();
    again?.release();
  });
});

describe('daemon probe', () => {
  it('sees a running supervisor and an absent one', async (context) => {
    const home = withTempDir(context, { asHome: true });
    const paths = momongaPaths(home);
    fs.mkdirSync(paths.run, { recursive: true, mode: 0o700 });
    const probe = nodeDaemonProbe(paths);
    expect(await probe.running()).toBe(false);

    const supervisor = await startFakeSupervisor({ paths, version: '1.0.0', children: readyChildren() });
    registerCleanup(context, () => supervisor.stop());
    expect(await probe.running()).toBe(true);
  });
});

describe('undici update http', () => {
  const serve = async (context: Parameters<typeof withTempDir>[0], handler: http.RequestListener): Promise<string> => {
    const server = http.createServer(handler);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    registerCleanup(context, () => new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    }));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  };

  it('follows redirects up to the bound and then fails instead of returning a redirect', async (context) => {
    const origin = await serve(context, (request, response) => {
      const hop = Number(request.url?.slice(1));
      if (hop < MAX_REDIRECTS + 2) {
        response.writeHead(302, { location: `/${hop + 1}` });
        response.end();
        return;
      }
      response.writeHead(200);
      response.end('arrived');
    });
    const signal = new AbortController().signal;

    await expect(undiciUpdateHttp().get(`${origin}/0`, { headers: {}, signal })).rejects.toThrow();
    const response = await undiciUpdateHttp().get(`${origin}/${MAX_REDIRECTS + 2}`, { headers: {}, signal });
    expect(response.status).toBe(200);
  });

  it('sends the given headers', async (context) => {
    let seen: http.IncomingHttpHeaders = {};
    const origin = await serve(context, (request, response) => {
      seen = request.headers;
      response.end('ok');
    });

    await undiciUpdateHttp().get(origin, { headers: { 'user-agent': 'momonga/1.0.0', accept: 'x/y' }, signal: new AbortController().signal });

    expect(seen['user-agent']).toBe('momonga/1.0.0');
    expect(seen['accept']).toBe('x/y');
  });
});
