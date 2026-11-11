import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import type net from 'node:net';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FIRST_GENERATION, ENDPOINT_TOKEN_FILE, createUdsClient, endpointScopeOf, ensureMomongaDirs, fixedSocket, generationLayout, listenUnix, momongaPaths, nodeFileSystem, pipePathFor, systemRandom } from '@momonga/foundation';
import type { EndpointScope } from '@momonga/foundation';
import { realProcessTestSignal, testKernelLock } from '@momonga/testkit';
import { makeTemporaryDirectory } from './support/temporary-directory.ts';

const TOKEN = '0123456789abcdef0123456789abcdef';
const HOME = 'C:\\Users\\Alice';
const PIPES: EndpointScope = { form: 'pipe', token: TOKEN };

const ports = () => ({ files: nodeFileSystem, random: systemRandom, lock: testKernelLock() });

describe('C23: every local endpoint on Windows is a named pipe whose name carries the random part of the home', () => {
  it('names each endpoint of a generation with the random part', () => {
    const layout = generationLayout(HOME, FIRST_GENERATION, 'win32', PIPES);
    expect(layout.sockets.runtime).toBe(`\\\\.\\pipe\\momonga-${TOKEN}-g1-runtime`);
    expect(new Set(Object.values(layout.sockets)).size).toBe(3);
    expect(pipePathFor(PIPES, 'g2-gateway')).toBe(`\\\\.\\pipe\\momonga-${TOKEN}-g2-gateway`);
  });

  it('refuses a pipe name without the random part, while the files of the generation stay readable', () => {
    expect(() => pipePathFor({ form: 'unix' }, 'g1-runtime')).toThrow(/random part/);
    expect(() => pipePathFor({ form: 'pipe', token: 'abc' }, 'g1-runtime')).toThrow(/random part/);
    const unscoped = generationLayout(HOME, FIRST_GENERATION, 'win32');
    expect(() => unscoped.sockets.runtime).toThrow(/random part/);
    expect(unscoped.locks.runtime).toBe('C:\\Users\\Alice\\.momonga\\run\\g1\\runtime.lock');
  });

  it('keeps the Unix sockets of the generation folder on the other platforms, with or without a scope', () => {
    expect(generationLayout('/home/a', FIRST_GENERATION, 'linux').sockets.runtime).toBe('/home/a/.momonga/run/g1/runtime.sock');
    expect(generationLayout('/home/a', FIRST_GENERATION, 'linux', { form: 'unix' }).sockets.runtime).toBe('/home/a/.momonga/run/g1/runtime.sock');
  });

  it('reads the random part from one owner-only file in run/, created once, and touches no file off Windows', async () => {
    const home = makeTemporaryDirectory();
    const paths = momongaPaths(home, process.platform, {});
    await ensureMomongaDirs(paths);
    expect(await endpointScopeOf(paths, 'darwin', ports())).toEqual({ form: 'unix' });
    expect(fs.existsSync(path.join(paths.run, ENDPOINT_TOKEN_FILE))).toBe(false);
    const first = await endpointScopeOf(paths, 'win32', ports());
    expect(first).toEqual({ form: 'pipe', token: fs.readFileSync(path.join(paths.run, ENDPOINT_TOKEN_FILE), 'utf8') });
    expect(fs.statSync(path.join(paths.run, ENDPOINT_TOKEN_FILE)).mode & 0o777).toBe(0o600);
    expect(await endpointScopeOf(paths, 'win32', ports())).toEqual(first);
  });

  it('gives a home whose random part differs other names, so its clients never reach this home', async () => {
    const scopes = await Promise.all(
      [makeTemporaryDirectory(), makeTemporaryDirectory()].map(async (home) => {
        const paths = momongaPaths(home, process.platform, {});
        await ensureMomongaDirs(paths);
        return endpointScopeOf(paths, 'win32', ports());
      }),
    );
    const names = scopes.map((scope) => generationLayout(HOME, FIRST_GENERATION, 'win32', scope).sockets.supervisor);
    expect(names[0]).not.toBe(names[1]);
  });
});

describe('C23: a named pipe without the random part is neither served nor dialled', () => {
  const UNSCOPED = '\\\\.\\pipe\\momonga-0123456789abcdef-g1-runtime';

  const listeningServer = (): { server: net.Server; listened: string[] } => {
    const listened: string[] = [];
    const emitter = new EventEmitter();
    const server = Object.assign(emitter, {
      listen: (name: string, callback: () => void) => {
        listened.push(name);
        callback();
        return emitter;
      },
    }) as unknown as net.Server;
    return { server, listened };
  };

  it('refuses to listen on a pipe name that carries no random part, and listens on one that does', async () => {
    const refused = listeningServer();
    await expect(listenUnix(refused.server, UNSCOPED, { mechanism: testKernelLock() }, realProcessTestSignal())).rejects.toThrow(/random part/);
    expect(refused.listened).toEqual([]);
    const served = listeningServer();
    const scoped = pipePathFor(PIPES, 'g1-runtime');
    await listenUnix(served.server, scoped, { mechanism: testKernelLock() }, realProcessTestSignal());
    expect(served.listened).toEqual([scoped]);
  });

  it('refuses to dial a pipe name that carries no random part', async () => {
    const client = createUdsClient(fixedSocket(UNSCOPED), { connectTimeoutMs: 1000 });
    try {
      await expect(client.request({ method: 'GET', path: '/health' })).rejects.toThrow(/random part/);
    } finally {
      await client.destroy();
    }
  });
});
