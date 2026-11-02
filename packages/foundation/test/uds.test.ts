import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProcessLockHeldError, createUdsClient, inspectProcessLock, listenUnix } from '@momonga/foundation';
import type { KernelLockMechanism } from '@momonga/foundation';
import { registerCleanup, withTempDir } from '@momonga/testkit';
import { startHolder } from './support/lock-processes.ts';

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const makeDir = (mode = 0o700): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-'));
  fs.chmodSync(dir, mode);
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

const track = (server: http.Server): http.Server => {
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        if (!server.listening) {
          resolve();
          return;
        }
        server.close(() => resolve());
      }),
  );
  return server;
};

const echoServer = (): http.Server =>
  track(
    http.createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'application/json', 'x-echo-method': request.method ?? '' });
        response.end(
          JSON.stringify({
            method: request.method,
            url: request.url,
            header: request.headers['x-test'] ?? null,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      });
    }),
  );

const client = (socketPath: string): ReturnType<typeof createUdsClient> => {
  const created = createUdsClient(socketPath);
  cleanups.push(() => created.close());
  return created;
};

describe('listenUnix', () => {
  it('listens on a socket in a 0700 directory and leaves the socket mode 0600', async () => {
    const socketPath = path.join(makeDir(), 's.sock');
    const server = echoServer();
    await listenUnix(server, socketPath);
    expect(server.listening).toBe(true);
    const stat = fs.statSync(socketPath);
    expect(stat.isSocket()).toBe(true);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('rejects when the parent directory is not 0700', async () => {
    const socketPath = path.join(makeDir(0o755), 's.sock');
    const server = echoServer();
    await expect(listenUnix(server, socketPath)).rejects.toThrow();
    expect(server.listening).toBe(false);
    expect(fs.existsSync(socketPath)).toBe(false);
  });

  it('rejects socket paths of 104 bytes or more with a clear error', async () => {
    const dir = makeDir();
    const name = 'x'.repeat(104 - Buffer.byteLength(dir) - 1);
    const socketPath = path.join(dir, name);
    expect(Buffer.byteLength(socketPath)).toBe(104);
    const server = echoServer();
    await expect(listenUnix(server, socketPath)).rejects.toThrow(/104/);
    expect(server.listening).toBe(false);
  });

  it('accepts a socket path of 103 bytes', async () => {
    const dir = makeDir();
    const socketPath = path.join(dir, 'y'.repeat(103 - Buffer.byteLength(dir) - 1));
    expect(Buffer.byteLength(socketPath)).toBe(103);
    await listenUnix(echoServer(), socketPath);
    expect(fs.statSync(socketPath).isSocket()).toBe(true);
  });

  it('removes a stale socket file left by a dead process', async () => {
    const socketPath = path.join(makeDir(), 'stale.sock');
    const script = `require('node:net').createServer().listen(${JSON.stringify(socketPath)}, () => process.kill(process.pid, 'SIGKILL'))`;
    spawnSync(process.execPath, ['-e', script]);
    expect(fs.statSync(socketPath).isSocket()).toBe(true);
    const server = echoServer();
    await listenUnix(server, socketPath);
    const response = await client(socketPath).request({ method: 'GET', path: '/alive' });
    expect(response.status).toBe(200);
  });

  it('refuses to take over a socket that a live server is using', async () => {
    const socketPath = path.join(makeDir(), 'live.sock');
    await listenUnix(echoServer(), socketPath);
    const intruder = echoServer();
    await expect(listenUnix(intruder, socketPath)).rejects.toThrow();
    expect(intruder.listening).toBe(false);
    const response = await client(socketPath).request({ method: 'GET', path: '/still-there' });
    expect(response.status).toBe(200);
  });
});

describe('listenUnix locking', () => {
  const holderScript = (socketPath: string): string => `
    import net from 'node:net';
    import { listenUnix } from ${JSON.stringify(path.resolve(import.meta.dirname, '../src/uds.ts'))};
    try {
      await listenUnix(net.createServer(), ${JSON.stringify(socketPath)});
      process.stdout.write('won\\n');
      process.stdin.resume();
    } catch {
      process.stdout.write('lost\\n');
      process.exit(0);
    }
  `;

  const outcomeOf = (child: ReturnType<typeof spawn>): Promise<string> =>
    new Promise((resolve, reject) => {
      let output = '';
      child.stdout?.on('data', (chunk: Buffer) => {
        output += chunk.toString('utf8');
        if (output.includes('\n')) resolve(output.trim());
      });
      child.once('error', reject);
      child.once('exit', () => resolve(output.trim()));
    });

  it('lets exactly one of two processes listen on the same socket path', async () => {
    const socketPath = path.join(makeDir(), 'race.sock');
    const children = [0, 1].map(() =>
      spawn(process.execPath, ['--input-type=module', '-e', holderScript(socketPath)], {
        stdio: ['pipe', 'pipe', 'inherit'],
      }),
    );
    for (const child of children) cleanups.push(() => void child.kill('SIGKILL'));
    const outcomes = await Promise.all(children.map(outcomeOf));
    expect([...outcomes].sort()).toEqual(['lost', 'won']);
  });

  it('takes over a lock whose process is dead', async () => {
    const socketPath = path.join(makeDir(), 'dead.sock');
    const finished = spawnSync(process.execPath, ['-e', '']);
    const deadPid = finished.pid;
    fs.writeFileSync(`${socketPath}.lock`, String(deadPid), { mode: 0o600 });
    const server = echoServer();
    await listenUnix(server, socketPath);
    expect(server.listening).toBe(true);
    expect(fs.readFileSync(`${socketPath}.lock`, 'utf8')).toBe(String(process.pid));
  });

  it('rejects when the lock is held by a live process', async (context) => {
    const socketPath = path.join(withTempDir(context), 'held.sock');
    const holder = await startHolder(context, `${socketPath}.lock`);
    const server = echoServer();
    await expect(listenUnix(server, socketPath)).rejects.toThrow(/in use/);
    expect(server.listening).toBe(false);
    expect(await inspectProcessLock(`${socketPath}.lock`)).toEqual({ state: 'held', pid: holder.pid });
  });

  it('lets exactly one of several processes take over a dead-pid lock and leaves no stray files', async () => {
    const dir = makeDir();
    const socketPath = path.join(dir, 'takeover.sock');
    const finished = spawnSync(process.execPath, ['-e', '']);
    fs.writeFileSync(`${socketPath}.lock`, String(finished.pid), { mode: 0o600 });
    const children = [0, 1, 2, 3].map(() =>
      spawn(process.execPath, ['--input-type=module', '-e', holderScript(socketPath)], {
        stdio: ['pipe', 'pipe', 'inherit'],
      }),
    );
    for (const child of children) cleanups.push(() => void child.kill('SIGKILL'));
    const outcomes = await Promise.all(children.map(outcomeOf));
    expect(outcomes.filter((outcome) => outcome === 'won')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome === 'lost')).toHaveLength(3);
    const winner = children[outcomes.indexOf('won')];
    expect(fs.readFileSync(`${socketPath}.lock`, 'utf8')).toBe(String(winner?.pid));
    expect(fs.readdirSync(dir).sort()).toEqual(['takeover.sock', 'takeover.sock.lock']);
  });

  it('holds the kernel lock without any temporary file beside the socket', async (context) => {
    const socketPath = path.join(withTempDir(context), 'atomic.sock');
    await listenUnix(echoServer(), socketPath);
    expect(fs.readdirSync(path.dirname(socketPath)).sort()).toEqual(['atomic.sock', 'atomic.sock.lock']);
    expect(await inspectProcessLock(`${socketPath}.lock`)).toEqual({ state: 'held', pid: process.pid });
  });

  it('ignores an empty lock file that has no holder', async () => {
    const socketPath = path.join(makeDir(), 'garbled.sock');
    const lockPath = `${socketPath}.lock`;
    fs.writeFileSync(lockPath, '', { mode: 0o600 });
    const server = echoServer();
    await listenUnix(server, socketPath);
    expect(server.listening).toBe(true);
    expect(fs.readFileSync(lockPath, 'utf8')).toBe(String(process.pid));
  });

  it('names the socket, the holder and the lock path when another process holds the lock', async (context) => {
    const socketPath = path.join(withTempDir(context), 'reused.sock');
    const lockPath = `${socketPath}.lock`;
    const holder = await startHolder(context, lockPath);
    const error = await listenUnix(echoServer(), socketPath).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProcessLockHeldError);
    expect((error as Error).message).toBe(`${socketPath} is already in use by process ${holder.pid} (lock ${lockPath})`);
  });

  it('releases the lock when the server closes', async () => {
    const socketPath = path.join(makeDir(), 'release.sock');
    const server = echoServer();
    await listenUnix(server, socketPath);
    expect(await inspectProcessLock(`${socketPath}.lock`)).toEqual({ state: 'held', pid: process.pid });
    await new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
    expect(await inspectProcessLock(`${socketPath}.lock`)).toEqual({ state: 'free' });
  });

  it('releases the lock when listening fails', async () => {
    const dir = makeDir();
    const socketPath = path.join(dir, 'file.sock');
    fs.writeFileSync(socketPath, 'not a socket');
    await expect(listenUnix(echoServer(), socketPath)).rejects.toThrow(/not a socket/);
    expect(await inspectProcessLock(`${socketPath}.lock`)).toEqual({ state: 'free' });
  });
});

describe('createUdsClient', () => {
  const listenEcho = async (): Promise<string> => {
    const socketPath = path.join(makeDir(), 'e.sock');
    await listenUnix(echoServer(), socketPath);
    return socketPath;
  };

  it('performs a GET and exposes status, headers and json()', async () => {
    const socketPath = await listenEcho();
    const response = await client(socketPath).request({ method: 'GET', path: '/v1/models?x=1', headers: { 'x-test': 'yes' } });
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('application/json');
    expect(await response.json()).toEqual({ method: 'GET', url: '/v1/models?x=1', header: 'yes', body: '' });
  });

  it('sends a POST body and exposes text()', async () => {
    const socketPath = await listenEcho();
    const response = await client(socketPath).request({
      method: 'POST',
      path: '/echo',
      headers: { 'content-type': 'application/json' },
      body: '{"a":1}',
    });
    expect(response.headers['x-echo-method']).toBe('POST');
    expect(JSON.parse(await response.text())).toEqual({ method: 'POST', url: '/echo', header: null, body: '{"a":1}' });
  });

  it('streams the body as Uint8Array chunks', async () => {
    const socketPath = path.join(makeDir(), 'b.sock');
    const server = track(
      http.createServer((_request, response) => {
        response.writeHead(200, { 'content-type': 'text/plain' });
        response.write('part-1;');
        setTimeout(() => response.end('part-2'), 10);
      }),
    );
    await listenUnix(server, socketPath);
    const response = await client(socketPath).request({ method: 'GET', path: '/' });
    const decoder = new TextDecoder();
    let text = '';
    for await (const chunk of response.body) {
      expect(chunk).toBeInstanceOf(Uint8Array);
      text += decoder.decode(chunk, { stream: true });
    }
    expect(text).toBe('part-1;part-2');
  });

  it('rejects the body stream when the signal aborts mid-response', async () => {
    const socketPath = path.join(makeDir(), 'a.sock');
    const server = track(
      http.createServer((_request, response) => {
        response.writeHead(200, { 'content-type': 'text/plain' });
        response.write('first');
      }),
    );
    await listenUnix(server, socketPath);
    const controller = new AbortController();
    const response = await client(socketPath).request({ method: 'GET', path: '/', signal: controller.signal });
    const iterator = response.body[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.done).toBe(false);
    controller.abort();
    const drain = (async () => {
      for (;;) {
        const next = await iterator.next();
        if (next.done) return 'ended-normally';
      }
    })();
    await expect(drain).rejects.toThrow();
  });

  it('rejects when the signal is already aborted', async () => {
    const socketPath = await listenEcho();
    await expect(
      client(socketPath).request({ method: 'GET', path: '/', signal: AbortSignal.abort() }),
    ).rejects.toThrow();
  });

  it('rejects when nothing listens on the socket', async () => {
    await expect(client(path.join(makeDir(), 'missing.sock')).request({ method: 'GET', path: '/' })).rejects.toThrow();
  });
});

describe('createUdsClient close', () => {
  it('ends the connection on the server when closed', async () => {
    const socketPath = path.join(makeDir(), 'c.sock');
    let connections = 0;
    const server = echoServer();
    server.on('connection', (socket: net.Socket) => {
      connections += 1;
      socket.once('close', () => {
        connections -= 1;
      });
    });
    await listenUnix(server, socketPath);
    const created = createUdsClient(socketPath);
    expect((await created.request({ method: 'GET', path: '/' })).status).toBe(200);
    expect(connections).toBe(1);
    await created.close();
    await vi.waitFor(() => expect(connections).toBe(0));
  });

  it('rejects requests made after close', async () => {
    const socketPath = path.join(makeDir(), 'd.sock');
    await listenUnix(echoServer(), socketPath);
    const created = createUdsClient(socketPath);
    await created.close();
    await expect(created.request({ method: 'GET', path: '/' })).rejects.toThrow();
  });

  it('allows close to be called twice', async () => {
    const created = createUdsClient(path.join(makeDir(), 'e.sock'));
    await created.close();
    await created.close();
  });
});

describe('createUdsClient timeouts', () => {
  const slowServer = async (delayMs: number): Promise<string> => {
    const socketPath = path.join(makeDir(), 'slow.sock');
    const server = track(
      http.createServer((request, response) => {
        request.resume();
        setTimeout(() => response.end('late'), delayMs);
      }),
    );
    await listenUnix(server, socketPath);
    return socketPath;
  };

  it('fails with a headers timeout when headersTimeoutMs is exceeded', async () => {
    const socketPath = await slowServer(3000);
    const limited = createUdsClient(socketPath, { headersTimeoutMs: 100 });
    cleanups.push(() => limited.close());
    await expect(limited.request({ method: 'GET', path: '/' })).rejects.toMatchObject({ code: 'UND_ERR_HEADERS_TIMEOUT' });
  }, 10_000);

  it('disables the headers timeout with headersTimeoutMs 0', async () => {
    const socketPath = await slowServer(100);
    const unbounded = createUdsClient(socketPath, { headersTimeoutMs: 0, bodyTimeoutMs: 0 });
    cleanups.push(() => unbounded.close());
    const response = await unbounded.request({ method: 'GET', path: '/' });
    expect(await response.text()).toBe('late');
  });
});

describe('listenUnix lock options', () => {
  it('forwards the lock mechanism to the socket lock', async (context) => {
    const socketPath = path.join(withTempDir(context), 'forwarded.sock');
    const claims: string[] = [];
    const mechanism: KernelLockMechanism = {
      name: 'file-lock',
      claim: async (lockPath) => {
        claims.push(lockPath);
        return { kind: 'held' };
      },
      isHeld: async () => true,
      readHolder: async () => undefined,
      readHolderSync: () => undefined,
      claimInheritable: undefined,
      adoptInherited: undefined,
    };
    const server = http.createServer();
    await expect(listenUnix(server, socketPath, { mechanism })).rejects.toBeInstanceOf(ProcessLockHeldError);
    expect(claims).toEqual([`${socketPath}.lock`]);
    expect(server.listening).toBe(false);
  });
});
