import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { LOCK_DATABASE_SUFFIX, createLockCapability, ensureMomongaDirs, kernelLockNamed, momongaPaths, sidecarOf, systemTiming } from '@momonga/foundation';
import type { OutboundNetwork } from '@momonga/foundation';
import { createTempDir, registerCleanup, removeTempDir, spawnTracked, testEndpointScope, withTempDir, testKernelLock } from '@momonga/testkit';
import { afterAll, describe, expect, it } from 'vitest';
import { daemonReadyBoundMs } from '../src/daemon/ensure-daemon.ts';
import type { CliPorts } from '../src/ports.ts';
import { MAX_REDIRECTS, STAGING_PREFIX, leasedUpdateHttp, nodeDaemonProbe, nodeUpdateFs, nodeUpdateLock, nodeUpdatePorts, nodeUpdateState, transferOptionsOf } from '../src/update/node-ports.ts';
import { DEFAULT_UPDATE_STALL_TIMEOUT_MS } from '@momonga/config';
import { readyChildren, startFakeSupervisor, virtualClock } from './fake-supervisor.ts';

const ASIDE_ENTRY = path.join(import.meta.dirname, 'update-aside-entry.ts');

const probeDirectory = createTempDir();
const proofDirectory = createTempDir();
afterAll(() => {
  removeTempDir(probeDirectory);
  removeTempDir(proofDirectory);
});
const HOST_PROVES_FILE_LOCK = (await createLockCapability({ proofDir: proofDirectory }).of(probeDirectory)) === 'proved';
const LOCK_MECHANISMS = (['file-lock', 'sqlite-lock'] as const).filter((mechanism) => mechanism === 'sqlite-lock' || HOST_PROVES_FILE_LOCK);

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
    interrupt: new AbortController().signal,
    platform: 'linux',
    env: { PATH: '/usr/bin', UNSET: undefined },
    cwd: home,
    home,
    stdout: { write: () => undefined },
    stderr: { write: () => undefined },
    stdin: unusedPort('stdin'),
    clock: virtualClock(),
    timers: unusedPort('timers'),
    random: () => 0,
    uuid: unusedPort('uuid'),
    process: unusedPort('process'),
    tmpdir: home,
    self: { kind: 'single-binary', execPath: path.join(home, 'momonga') },
    spawnDetached: () => ({ exit: new Promise(() => undefined) }),
    terminal: undefined,
    files: unusedPort('files'),
    openUrl: unusedPort('openUrl'),
    exec: unusedPort('exec'),
    hostLaunch: unusedPort('hostLaunch'),
    probe: unusedPort('probe'),
    secretStore: unusedPort('secretStore'),
    personCapability: unusedPort('personCapability'),
    endpointScope: testEndpointScope,
  }) satisfies CliPorts;

describe('autoUpdates', () => {
  it('is on by default and follows the user settings file', async (context) => {
    const home = withTempDir(context, { asHome: true });
    const ports = nodeUpdatePorts(cliPortsFor(home), momongaPaths(home, process.platform, process.env), testKernelLock());
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
    const ports = nodeUpdatePorts({ ...cliPortsFor(home), cwd: project }, momongaPaths(home, process.platform, process.env), testKernelLock());

    expect(await ports.autoUpdates()).toBe(true);
  });

  it('passes only defined environment variables to child commands', async (context) => {
    const home = withTempDir(context, { asHome: true });
    expect(nodeUpdatePorts(cliPortsFor(home), momongaPaths(home, process.platform, process.env), testKernelLock()).env).toEqual({ PATH: '/usr/bin' });
  });
});

describe('update state store', () => {
  it('reads undefined before the first write and returns what was written afterwards', async (context) => {
    const home = withTempDir(context, { asHome: true });
    const paths = momongaPaths(home, process.platform, process.env);
    await ensureMomongaDirs(paths);
    const store = nodeUpdateState(paths, testKernelLock());
    expect(await store.read()).toBeUndefined();

    await store.write({ checkedAt: 7, outcome: { kind: 'up_to_date' }, announced: true });

    expect(JSON.parse(await store.read() ?? '')).toEqual({ checkedAt: 7, outcome: { kind: 'up_to_date' }, announced: true });
    expect(fs.readdirSync(path.join(home, '.momonga', 'state')).filter((entry) => entry.startsWith('update.json'))).toEqual(['update.json']);
  });

  it('hands the text of the file to the one parser, and names the file it reads', async (context) => {
    const home = withTempDir(context, { asHome: true });
    const paths = momongaPaths(home, process.platform, process.env);
    await ensureMomongaDirs(paths);
    const store = nodeUpdateState(paths, testKernelLock());
    await store.write({});
    fs.writeFileSync(path.join(paths.state, 'update.json'), '{ nope');

    expect(store.file).toBe(path.join(paths.state, 'update.json'));
    expect(await store.read()).toBe('{ nope');
  });
});

describe('update lock', () => {
  it('hands the lock to one holder at a time', async (context) => {
    const home = withTempDir(context, { asHome: true });
    const paths = momongaPaths(home, process.platform, process.env);
    await ensureMomongaDirs(paths);
    const lock = nodeUpdateLock(paths, testKernelLock());

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
    const paths = momongaPaths(home, process.platform, process.env);
    await ensureMomongaDirs(paths);
    const lock = nodeUpdateLock(paths, testKernelLock());
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
    const paths = momongaPaths(home, process.platform, process.env);
    fs.mkdirSync(paths.run, { recursive: true, mode: 0o700 });
    const probe = nodeDaemonProbe(paths, { clock: virtualClock(), endpointScope: testEndpointScope }, testKernelLock());
    expect(await probe.running()).toBe(false);

    const supervisor = await startFakeSupervisor({ paths, version: '1.0.0', children: readyChildren() });
    registerCleanup(context, () => supervisor.stop());
    expect(await probe.running()).toBe(true);
  });

  it('sees a live retiring generation when the generation run/current names is gone (20.72)', async (context) => {
    const home = withTempDir(context, { asHome: true });
    const paths = momongaPaths(home, process.platform, process.env);
    await ensureMomongaDirs(paths);
    const retiring = await startFakeSupervisor({ paths, version: '1.0.0', generation: 1, children: readyChildren() });
    registerCleanup(context, () => retiring.stop());
    const ended = await startFakeSupervisor({ paths, version: '1.1.0', generation: 2, children: readyChildren() });
    await ended.stop();

    expect(await nodeDaemonProbe(paths, { clock: virtualClock(), endpointScope: testEndpointScope }, testKernelLock()).running()).toBe(true);
  });

  it('sums the work of the live generations below the serving one, with their versions (20.72)', async (context) => {
    const home = withTempDir(context, { asHome: true });
    const paths = momongaPaths(home, process.platform, process.env);
    await ensureMomongaDirs(paths);
    for (const [generation, version, steps, jobs] of [[1, '0.9.0', 1, 1], [2, '1.0.0', 1, 0], [3, '2.0.0', 5, 5]] as const) {
      const supervisor = await startFakeSupervisor({ paths, version, generation, children: readyChildren(), reports: { steps, jobs, calls: 0 } });
      registerCleanup(context, () => supervisor.stop());
    }

    expect(await nodeDaemonProbe(paths, { clock: virtualClock(), endpointScope: testEndpointScope }, testKernelLock()).retiring()).toEqual({ steps: 2, jobs: 1, versions: ['0.9.0', '1.0.0'] });
  });

  it('gives the ready bound of the daemon as the wait of the start after an install (20.72)', async (context) => {
    const home = withTempDir(context, { asHome: true });
    expect(await nodeDaemonProbe(momongaPaths(home, process.platform, process.env), { clock: virtualClock(), endpointScope: testEndpointScope }, testKernelLock()).readyBoundMs()).toBe(await daemonReadyBoundMs());
  });
});

const DIRECT_NETWORK: OutboundNetwork = { config: { caFiles: [] }, trust: { sources: [], failures: [] } };

const closeFailures: unknown[] = [];

const directHttp = leasedUpdateHttp((_signal, use) => use(DIRECT_NETWORK), transferOptionsOf(DEFAULT_UPDATE_STALL_TIMEOUT_MS), (error) => void closeFailures.push(error));

describe('update http', () => {
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

    await expect(directHttp.get(`${origin}/0`, { headers: {}, signal })).rejects.toThrow();
    const response = await directHttp.get(`${origin}/${MAX_REDIRECTS + 2}`, { headers: {}, signal });
    expect(response.status).toBe(200);
    expect(closeFailures).toEqual([]);
  });

  it('is the http port of the update ports the product composes', async (context) => {
    const origin = await serve(context, (request, response) => {
      const hop = Number(request.url?.slice(1));
      if (hop < MAX_REDIRECTS + 2) {
        response.writeHead(302, { location: `/${hop + 1}` });
        response.end();
        return;
      }
      response.end('arrived');
    });
    const home = withTempDir(context, { asHome: true });
    const http = nodeUpdatePorts({ ...cliPortsFor(home), timers: systemTiming }, momongaPaths(home, process.platform, process.env), testKernelLock()).http;
    const signal = new AbortController().signal;

    await expect(http.get(`${origin}/0`, { headers: {}, signal })).rejects.toThrow();
    const response = await http.get(`${origin}/${MAX_REDIRECTS + 2}`, { headers: {}, signal });
    expect(response.status).toBe(200);
    for await (const chunk of response.body) expect(chunk).toBeDefined();
  });

  it('sends the given headers', async (context) => {
    let seen: http.IncomingHttpHeaders = {};
    const origin = await serve(context, (request, response) => {
      seen = request.headers;
      response.end('ok');
    });

    await directHttp.get(origin, { headers: { 'user-agent': 'momonga/1.0.0', accept: 'x/y' }, signal: new AbortController().signal });

    expect(seen['user-agent']).toBe('momonga/1.0.0');
    expect(seen['accept']).toBe('x/y');
  });
});

describe('the aside install.ps1 leaves beside a running momonga.exe', () => {
  for (const mechanism of LOCK_MECHANISMS) {
    it(`is removed by the one update sweep once no process holds it (${mechanism})`, async (context) => {
      const directory = withTempDir(context);
      const aside = path.join(directory, `${STAGING_PREFIX}0123456789abcdef0123456789abcdef`);
      fs.writeFileSync(path.join(directory, 'momonga.exe'), 'new');
      fs.writeFileSync(aside, 'old');
      fs.writeFileSync(`${aside}${LOCK_DATABASE_SUFFIX}`, '');
      await nodeUpdateFs(kernelLockNamed(mechanism)).removeLeftovers(directory);
      expect(fs.readdirSync(directory)).toEqual(['momonga.exe']);
    });
  }
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
    await nodeUpdateFs(testKernelLock()).publish(staged, target);
    expect(fs.readFileSync(target, 'utf8')).toBe('new');
    expect(fs.readdirSync(directory)).toEqual(['momonga.exe']);
  });

  it('moves the running file aside and then moves the new one in when the platform refuses to replace it', async (context) => {
    const { directory, target, staged } = await setup(context);
    await nodeUpdateFs(testKernelLock(), runningImageRename(target)).publish(staged, target);
    expect(fs.readFileSync(target, 'utf8')).toBe('new');
    const isSideFile = (name: string): boolean => name.includes(sidecarOf(testKernelLock(), ''));
    const asides = fs.readdirSync(directory).filter((name) => name !== 'momonga.exe' && !isSideFile(name));
    expect(asides).toHaveLength(1);
    expect(asides[0]?.startsWith(STAGING_PREFIX)).toBe(true);
    expect(fs.readFileSync(path.join(directory, asides[0] as string), 'utf8')).toBe('old');
  });

  for (const mechanism of LOCK_MECHANISMS) {
    it(`names the aside of the running file as a locked entry that the sweep keeps while its process runs and removes after it ends (${mechanism})`, async (context) => {
      const { directory, target, staged } = await setup(context);
      const child = spawnTracked(context, process.execPath, [ASIDE_ENTRY, mechanism, target, staged], { stdio: ['pipe', 'pipe', 'pipe'] });
      const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
      let stderr = '';
      (child.stderr as Readable).on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
      await new Promise<void>((resolve, reject) => {
        (child.stdout as Readable).on('data', (chunk: Buffer) => {
          if (chunk.toString('utf8').includes('published')) resolve();
        });
        child.once('exit', () => reject(new Error(`the publishing process ended before it published: ${stderr}`)));
      });
      const asideOf = (): string[] => fs.readdirSync(directory).filter((name) => name.startsWith(STAGING_PREFIX) && !name.slice(STAGING_PREFIX.length).includes('.'));
      expect(fs.readFileSync(target, 'utf8')).toBe('new');
      expect(asideOf()).toHaveLength(1);

      await nodeUpdateFs(kernelLockNamed(mechanism)).removeLeftovers(directory);
      expect(asideOf()).toHaveLength(1);

      (child.stdin as Writable).end();
      expect(await exited).toBe(0);
      await nodeUpdateFs(kernelLockNamed(mechanism)).removeLeftovers(directory);
      expect(fs.readdirSync(directory)).toEqual(['momonga.exe']);
    });
  }

  it('puts the old file back when the new one cannot be moved in', async (context) => {
    const { directory, target, staged } = await setup(context);
    const rename = async (from: string, to: string): Promise<void> => {
      if (from === staged) throw refusal('EIO');
      if (to === target && fs.existsSync(target)) throw refusal('EBUSY');
      await fs.promises.rename(from, to);
    };
    await expect(nodeUpdateFs(testKernelLock(), rename).publish(staged, target)).rejects.toMatchObject({ code: 'EIO' });
    expect(fs.readFileSync(target, 'utf8')).toBe('old');
    expect(fs.readdirSync(directory).sort()).toEqual([path.basename(staged), 'momonga.exe'].sort());
  });

  it('reports the refusal and leaves the file alone when moving the old file aside is refused too', async (context) => {
    const { target, staged } = await setup(context);
    const rename = async (): Promise<void> => {
      throw refusal('EACCES');
    };
    const outcome = nodeUpdateFs(testKernelLock(), rename).publish(staged, target);
    await expect(outcome).rejects.toMatchObject({ code: 'EACCES' });
    await expect(outcome).rejects.toThrow(/stop the daemon, then run the command again/);
    expect(fs.readFileSync(target, 'utf8')).toBe('old');
  });

  it('does not move the file aside for a refusal that is not about a busy or protected target', async (context) => {
    const { target, staged } = await setup(context);
    const seen: string[] = [];
    const rename = async (from: string, to: string): Promise<void> => {
      seen.push(`${path.basename(from)}>${path.basename(to)}`);
      throw refusal('ENOSPC');
    };
    await expect(nodeUpdateFs(testKernelLock(), rename).publish(staged, target)).rejects.toMatchObject({ code: 'ENOSPC' });
    expect(seen).toHaveLength(1);
  });
});
