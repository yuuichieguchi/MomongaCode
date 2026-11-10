import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { STARTUP_TIMEOUT_MS, ensureMomongaDirs, momongaPaths } from '@momonga/foundation';
import { registerCleanup, withTempDir } from '@momonga/testkit';
import { describe, expect, it } from 'vitest';
import type { CliPorts } from '../src/ports.ts';
import { MAX_REDIRECTS, STAGING_PREFIX, nodeDaemonProbe, nodeUpdateFs, nodeUpdateLock, nodeUpdatePorts, nodeUpdateState, undiciUpdateHttp } from '../src/update/node-ports.ts';
import { readyChildren, startFakeSupervisor, virtualClock } from './fake-supervisor.ts';

const unusedPort = (name: string): never =>
  new Proxy(() => undefined, {
    apply: () => {
      throw new Error(`the update test did not expect the ${name} port`);
    },
    get: () => unusedPort(name),
  }) as never;

const cliPortsFor = (home: string): CliPorts =>
  ({
    version: '1.0.0',
    platform: 'linux',
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
    const paths = momongaPaths(home);
    await ensureMomongaDirs(paths);
    const store = nodeUpdateState(paths);
    expect(await store.read()).toBeUndefined();

    await store.write({ checkedAt: 7, outcome: { kind: 'up_to_date' }, announced: true });

    expect(await store.read()).toEqual({ checkedAt: 7, outcome: { kind: 'up_to_date' }, announced: true });
    expect(fs.readdirSync(path.join(home, '.momonga', 'state')).filter((entry) => entry.startsWith('update.json'))).toEqual(['update.json']);
  });

  it('fails on a file that is not JSON', async (context) => {
    const home = withTempDir(context, { asHome: true });
    const paths = momongaPaths(home);
    await ensureMomongaDirs(paths);
    const store = nodeUpdateState(paths);
    await store.write({});
    fs.writeFileSync(path.join(paths.state, 'update.json'), '{ nope');

    await expect(store.read()).rejects.toThrow(SyntaxError);
  });
});

describe('update lock', () => {
  it('hands the lock to one holder at a time', async (context) => {
    const home = withTempDir(context, { asHome: true });
    const paths = momongaPaths(home);
    await ensureMomongaDirs(paths);
    const lock = nodeUpdateLock(paths);

    const first = await lock.acquire();
    expect(first).toBeDefined();
    expect(await lock.acquire()).toBeUndefined();

    first?.release();
    const again = await lock.acquire();
    expect(again).toBeDefined();
    again?.release();
  });

  it('reports a held lock without taking it', async (context) => {
    const home = withTempDir(context, { asHome: true });
    const paths = momongaPaths(home);
    await ensureMomongaDirs(paths);
    const lock = nodeUpdateLock(paths);
    expect(await lock.isHeld()).toBe(false);

    const held = await lock.acquire();
    expect(await lock.isHeld()).toBe(true);

    held?.release();
    expect(await lock.isHeld()).toBe(false);
  });
});

describe('daemon probe', () => {
  it('sees a running supervisor and an absent one', async (context) => {
    const home = withTempDir(context, { asHome: true });
    const paths = momongaPaths(home);
    fs.mkdirSync(paths.run, { recursive: true, mode: 0o700 });
    const probe = nodeDaemonProbe(paths, virtualClock());
    expect(await probe.running()).toBe(false);

    const supervisor = await startFakeSupervisor({ paths, version: '1.0.0', children: readyChildren() });
    registerCleanup(context, () => supervisor.stop());
    expect(await probe.running()).toBe(true);
  });

  it('sees a live retiring generation when the generation run/current names is gone (20.72)', async (context) => {
    const home = withTempDir(context, { asHome: true });
    const paths = momongaPaths(home);
    await ensureMomongaDirs(paths);
    const retiring = await startFakeSupervisor({ paths, version: '1.0.0', generation: 1, children: readyChildren() });
    registerCleanup(context, () => retiring.stop());
    const ended = await startFakeSupervisor({ paths, version: '1.1.0', generation: 2, children: readyChildren() });
    await ended.stop();

    expect(await nodeDaemonProbe(paths, virtualClock()).running()).toBe(true);
  });

  it('sums the work of the live generations below the serving one, with their versions (20.72)', async (context) => {
    const home = withTempDir(context, { asHome: true });
    const paths = momongaPaths(home);
    await ensureMomongaDirs(paths);
    for (const [generation, version, steps, jobs] of [[1, '0.9.0', 1, 1], [2, '1.0.0', 1, 0], [3, '2.0.0', 5, 5]] as const) {
      const supervisor = await startFakeSupervisor({ paths, version, generation, children: readyChildren(), reports: { steps, jobs, calls: 0 } });
      registerCleanup(context, () => supervisor.stop());
    }

    expect(await nodeDaemonProbe(paths, virtualClock()).retiring()).toEqual({ steps: 2, jobs: 1, versions: ['0.9.0', '1.0.0'] });
  });

  it('bounds the start after an install by the ready bound alone (20.72)', async (context) => {
    const home = withTempDir(context, { asHome: true });
    expect(await nodeDaemonProbe(momongaPaths(home), virtualClock()).restartBoundMs()).toBe(STARTUP_TIMEOUT_MS);
    expect(STARTUP_TIMEOUT_MS).toBe(60_000);
  });
});

const DIRECT_NETWORK = Promise.resolve({ config: { caFiles: [] }, trust: { sources: [], failures: [] } });

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

    await expect(undiciUpdateHttp(DIRECT_NETWORK).get(`${origin}/0`, { headers: {}, signal })).rejects.toThrow();
    const response = await undiciUpdateHttp(DIRECT_NETWORK).get(`${origin}/${MAX_REDIRECTS + 2}`, { headers: {}, signal });
    expect(response.status).toBe(200);
  });

  it('sends the given headers', async (context) => {
    let seen: http.IncomingHttpHeaders = {};
    const origin = await serve(context, (request, response) => {
      seen = request.headers;
      response.end('ok');
    });

    await undiciUpdateHttp(DIRECT_NETWORK).get(origin, { headers: { 'user-agent': 'momonga/1.0.0', accept: 'x/y' }, signal: new AbortController().signal });

    expect(seen['user-agent']).toBe('momonga/1.0.0');
    expect(seen['accept']).toBe('x/y');
  });
});

describe('publishing over a running executable', () => {
  const refusal = (code: string): NodeJS.ErrnoException => Object.assign(new Error(`${code}: rename refused`), { code });

  const runningImageRename =
    (target: string, code = 'EBUSY') =>
    async (from: string, to: string): Promise<void> => {
      if (to === target && fs.existsSync(target)) throw refusal(code);
      await fs.promises.rename(from, to);
    };

  const setup = async (context: Parameters<typeof withTempDir>[0]) => {
    const directory = withTempDir(context);
    const target = path.join(directory, 'momonga.exe');
    const staged = path.join(directory, `${STAGING_PREFIX}new`);
    fs.writeFileSync(target, 'old');
    fs.writeFileSync(staged, 'new');
    return { directory, target, staged };
  };

  it('replaces the file with one rename when the platform allows it', async (context) => {
    const { directory, target, staged } = await setup(context);
    await nodeUpdateFs().publish(staged, target);
    expect(fs.readFileSync(target, 'utf8')).toBe('new');
    expect(fs.readdirSync(directory)).toEqual(['momonga.exe']);
  });

  it('moves the running file aside and then moves the new one in when the platform refuses to replace it', async (context) => {
    const { directory, target, staged } = await setup(context);
    await nodeUpdateFs(runningImageRename(target)).publish(staged, target);
    expect(fs.readFileSync(target, 'utf8')).toBe('new');
    const leftovers = fs.readdirSync(directory).filter((name) => name !== 'momonga.exe');
    expect(leftovers).toHaveLength(1);
    expect(leftovers[0]?.startsWith(STAGING_PREFIX)).toBe(true);
    expect(fs.readFileSync(path.join(directory, leftovers[0] as string), 'utf8')).toBe('old');
    await nodeUpdateFs().removeLeftovers(directory);
    expect(fs.readdirSync(directory)).toEqual(['momonga.exe']);
  });

  it('puts the old file back when the new one cannot be moved in', async (context) => {
    const { directory, target, staged } = await setup(context);
    const rename = async (from: string, to: string): Promise<void> => {
      if (from === staged) throw refusal('EIO');
      if (to === target && fs.existsSync(target)) throw refusal('EBUSY');
      await fs.promises.rename(from, to);
    };
    await expect(nodeUpdateFs(rename).publish(staged, target)).rejects.toMatchObject({ code: 'EIO' });
    expect(fs.readFileSync(target, 'utf8')).toBe('old');
    expect(fs.readdirSync(directory).sort()).toEqual([path.basename(staged), 'momonga.exe'].sort());
  });

  it('reports the refusal and leaves the file alone when moving the old file aside is refused too', async (context) => {
    const { target, staged } = await setup(context);
    const rename = async (): Promise<void> => {
      throw refusal('EACCES');
    };
    await expect(nodeUpdateFs(rename).publish(staged, target)).rejects.toMatchObject({ code: 'EACCES' });
    expect(fs.readFileSync(target, 'utf8')).toBe('old');
  });

  it('does not move the file aside for a refusal that is not about a busy or protected target', async (context) => {
    const { target, staged } = await setup(context);
    const seen: string[] = [];
    const rename = async (from: string, to: string): Promise<void> => {
      seen.push(`${path.basename(from)}>${path.basename(to)}`);
      throw refusal('ENOSPC');
    };
    await expect(nodeUpdateFs(rename).publish(staged, target)).rejects.toMatchObject({ code: 'ENOSPC' });
    expect(seen).toHaveLength(1);
  });
});
