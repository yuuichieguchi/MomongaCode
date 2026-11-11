import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_FILE_RULES, EMPTY_PROTECTED_SET } from '@momonga/foundation';
import { DEFAULT_BWRAP_PATH, createBubblewrapSandbox, createPlaceholderJournal, heldMountPoints } from '@momonga/sandbox';
import type { Sandbox, SandboxPolicy, SandboxedProcess } from '@momonga/sandbox';
import { REAL_PROCESS_TEST_TIMEOUT_MS, killGroupsForCleanup, testKernelLock } from '@momonga/testkit';
import { UNBOUNDED_BUILD_WAIT_MS } from './support/build-wait.ts';
import { createTempRoot, removeTempRoot } from './support/temp.ts';
import { LINUX_SOCKET_GUARD_SOURCE, LINUX_SOCKET_PROBE_SOURCE, compileLinuxProgram } from './linux-socket-guard.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const HAS_BWRAP = process.platform === 'linux' && fs.existsSync(DEFAULT_BWRAP_PATH);
const KILL_GRACE_MS = 2000;
const BASE_ENV = { PATH: '/usr/bin:/bin' };

type Listener = { path: string; connections: () => number; close: () => Promise<void> };

const collect = async (stream: AsyncIterable<Uint8Array>): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
};

const finished = async (proc: SandboxedProcess): Promise<{ stdout: string; stderr: string; code: number | null; signal: string | null; killedBy?: string }> => {
  const [stdout, stderr, exit] = await Promise.all([collect(proc.stdout), collect(proc.stderr), proc.exited]);
  return { stdout, stderr, ...exit };
};

const answering = (server: net.Server, count: { value: number }): void => {
  server.on('connection', (connection) => {
    count.value += 1;
    connection.on('error', () => connection.destroy());
    connection.on('data', () => connection.end('pong'));
  });
};

describe.runIf(HAS_BWRAP)('Unix sockets under the real Linux sandbox, with the socket guard compiled on this host', () => {
  let root = '';
  let guard = '';
  let probe = '';
  let work = '';
  let listed = '';
  let unlisted = '';
  let owned = '';
  let sandbox: Sandbox;
  let spawned: SandboxedProcess[] = [];
  let listeners: Listener[] = [];
  let scene = 0;

  beforeAll(() => {
    root = fs.realpathSync(createTempRoot());
    fs.chmodSync(root, 0o755);
    guard = path.join(root, 'bin', 'momonga-socket-guard');
    probe = path.join(root, 'bin', 'socket-probe');
    compileLinuxProgram(LINUX_SOCKET_GUARD_SOURCE, guard, { kind: 'host' });
    compileLinuxProgram(LINUX_SOCKET_PROBE_SOURCE, probe, { kind: 'host' });
  }, UNBOUNDED_BUILD_WAIT_MS);

  afterAll(async () => {
    await removeTempRoot(root);
  });

  const folder = (name: string): string => {
    const made = path.join(root, `scene-${scene}`, name);
    fs.mkdirSync(made, { recursive: true });
    return made;
  };

  beforeEach(() => {
    scene += 1;
    work = folder('work');
    listed = folder('listed');
    unlisted = folder('unlisted');
    owned = folder('owned');
    sandbox = createBubblewrapSandbox({
      lock: testKernelLock(),
      tmpRoot: folder('tmp'),
      killGraceMs: KILL_GRACE_MS,
      journal: createPlaceholderJournal(folder('journal')),
      holders: heldMountPoints,
      socketGuard: () => guard,
    });
  });

  afterEach(async () => {
    try {
      await killGroupsForCleanup(spawned.map((proc) => proc.pgid));
    } finally {
      await Promise.all(listeners.map((listener) => listener.close()));
      spawned = [];
      listeners = [];
    }
  });

  const policy = (overrides: Partial<SandboxPolicy> = {}): SandboxPolicy => ({
    writableRoots: [work],
    writeDenied: [],
    writeDeniedLiterals: [],
    protectedSet: EMPTY_PROTECTED_SET,
    fileRules: EMPTY_FILE_RULES,
    readDenied: [],
    network: 'deny',
    ...overrides,
  });

  const listenAt = async (file: string): Promise<Listener> => {
    const count = { value: 0 };
    const server = net.createServer();
    answering(server, count);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(file, resolve);
    });
    const listener: Listener = { path: file, connections: () => count.value, close: () => new Promise((resolve) => server.close(() => resolve())) };
    listeners.push(listener);
    return listener;
  };

  const listenOnLoopback = async (): Promise<{ port: number; connections: () => number }> => {
    const count = { value: 0 };
    const server = net.createServer();
    answering(server, count);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    listeners.push({ path: '', connections: () => count.value, close: () => new Promise((resolve) => server.close(() => resolve())) });
    return { port: (server.address() as net.AddressInfo).port, connections: () => count.value };
  };

  const sh = async (script: string, overrides: Partial<SandboxPolicy> = {}, signal: AbortSignal = new AbortController().signal): Promise<SandboxedProcess> => {
    const proc = await sandbox.spawn({ argv: ['/bin/sh', '-c', script], cwd: work, env: BASE_ENV }, policy(overrides), signal);
    spawned.push(proc);
    return proc;
  };

  const probed = async (words: string, overrides: Partial<SandboxPolicy> = {}): Promise<string> => (await finished(await sh(`${probe} ${words}`, overrides))).stdout.trim();

  describe('with no socket named', () => {
    it('a Unix socket cannot be made, whatever its kind', async () => {
      expect(await probed('socket stream')).toBe('EPERM');
      expect(await probed('socket datagram')).toBe('EPERM');
      expect(await probed('socket sequenced')).toBe('EPERM');
    });

    it('a connected pair of stream or sequenced-packet sockets works, and a datagram pair, which could address any path, cannot be made', async () => {
      expect(await probed('pair stream')).toBe('ok');
      expect(await probed('pair sequenced')).toBe('ok');
      expect(await probed('pair datagram')).toBe('EPERM');
      expect(await probed('pair raw')).toBe('EPERM');
    });

    it('a listener on the host is never reached, and a program that pipes to a child still runs', async () => {
      const listener = await listenAt(path.join(listed, 's'));

      expect(await probed(`connect ${listener.path}`)).toBe('EPERM');
      expect(listener.connections()).toBe(0);
      expect((await finished(await sh(`/bin/sh -c '/bin/echo piped | /bin/cat'`))).stdout.trim()).toBe('piped');
    });

    it('the command still ends with its own exit code', async () => {
      expect((await finished(await sh('exit 7'))).code).toBe(7);
    });

    it('io_uring, which would make socket calls the filter never sees, answers that the call does not exist', async () => {
      expect(await probed('io-uring')).toBe('ENOSYS');
    });
  });

  describe('with a socket named', () => {
    const named = (overrides: Partial<SandboxPolicy> = {}): Partial<SandboxPolicy> => ({ unixSocketAllow: [listed], ...overrides });

    it('a socket under the named path is reached and answers', async () => {
      const listener = await listenAt(path.join(listed, 's'));

      expect(await probed(`connect ${listener.path}`, named())).toBe('pong ok');
      expect(listener.connections()).toBe(1);
    });

    it('a socket under any other path is refused and never reached', async () => {
      const listener = await listenAt(path.join(unlisted, 's'));

      expect(await probed(`connect ${listener.path}`, named())).toBe('EPERM');
      expect(listener.connections()).toBe(0);
    });

    it('a name that leads to the named path through a link or the working folder is reached, and one that leads elsewhere is refused', async () => {
      const inside = await listenAt(path.join(listed, 's'));
      const outside = await listenAt(path.join(unlisted, 's'));
      fs.symlinkSync(inside.path, path.join(work, 'to-listed'));
      fs.symlinkSync(outside.path, path.join(work, 'to-unlisted'));
      fs.symlinkSync(outside.path, path.join(listed, 'out'));

      expect(await probed(`connect ${path.join(work, 'to-listed')}`, named())).toBe('pong ok');
      expect(await probed('connect to-listed', named())).toBe('pong ok');
      expect(await probed(`connect ${path.join(work, 'to-unlisted')}`, named())).toBe('EPERM');
      expect(await probed(`connect ${path.join(listed, 'out')}`, named())).toBe('EPERM');
      expect(outside.connections()).toBe(0);
      expect(inside.connections()).toBe(2);
    });

    it('a read-denied folder stays closed although a path inside it is named', async () => {
      const listener = await listenAt(path.join(owned, 's'));

      expect(await probed(`connect ${listener.path}`, { unixSocketAllow: [owned, listed], readDenied: [owned] })).toBe('EPERM');
      expect(listener.connections()).toBe(0);
    });

    it('a missing socket under the named path is reported as missing, and one elsewhere as refused', async () => {
      expect(await probed(`connect ${path.join(listed, 'absent')}`, named())).toBe('ENOENT');
      expect(await probed(`connect ${path.join(unlisted, 'absent')}`, named())).toBe('EPERM');
    });

    it('a datagram Unix socket, an abstract name and a bound name are refused', async () => {
      expect(await probed('socket datagram', named())).toBe('EPERM');
      expect(await probed('pair datagram', named())).toBe('EPERM');
      expect(await probed('connect-abstract momonga-test', named())).toBe('EPERM');
      expect(await probed(`bind ${path.join(work, 'b')}`, named())).toBe('EPERM');
      expect(fs.existsSync(path.join(work, 'b'))).toBe(false);
    });

    it('a stream socket can be made, and a connected pair still works', async () => {
      expect(await probed('socket stream', named())).toBe('ok');
      expect(await probed('pair stream', named())).toBe('ok');
      expect(await probed('io-uring', named())).toBe('ENOSYS');
    });

    it('with the network open, a loopback address is reached and bound through the guard as without it', async () => {
      const loopback = await listenOnLoopback();

      expect(await probed(`connect-loopback ${loopback.port}`, named({ network: 'allow' }))).toBe('pong ok');
      expect(await probed('bind-loopback', named({ network: 'allow' }))).toBe('ok');
      expect(loopback.connections()).toBe(1);
    });

    it('with the network closed, a loopback address of the host is not reached', async () => {
      const loopback = await listenOnLoopback();

      expect(await probed(`connect-loopback ${loopback.port}`, named())).not.toContain('ok');
      expect(loopback.connections()).toBe(0);
    });

    it('the command ends with its own exit code, and a stop request reaches it as a termination it can answer', async () => {
      expect((await finished(await sh('exit 7', named()))).code).toBe(7);

      const stop = new AbortController();
      const proc = await sh(`trap 'echo asked; exit 0' TERM; echo ready; sleep 600 & wait`, named(), stop.signal);
      const output: string[] = [];
      const reading = (async () => {
        for await (const chunk of proc.stdout) {
          output.push(Buffer.from(chunk).toString('utf8'));
          if (output.join('').includes('ready')) stop.abort();
        }
      })();
      const exit = await proc.exited;
      await reading;

      expect(output.join('')).toContain('asked');
      expect(exit.killedBy).toBe('abort');
    });
  });

  describe('with a socket named and no guard given to the sandbox', () => {
    it('the command is not started, with the reason', async () => {
      const bare = createBubblewrapSandbox({ lock: testKernelLock(), tmpRoot: folder('tmp-bare'), killGraceMs: KILL_GRACE_MS, journal: createPlaceholderJournal(folder('journal-bare')), holders: heldMountPoints });

      await expect(bare.spawn({ argv: ['/bin/true'], cwd: work, env: BASE_ENV }, policy({ unixSocketAllow: [listed] }), new AbortController().signal)).rejects.toMatchObject({ code: 'socket_guard_missing' });
    });
  });
});
