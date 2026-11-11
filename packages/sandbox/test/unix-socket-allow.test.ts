import { EMPTY_FILE_RULES, EMPTY_PROTECTED_SET } from '@momonga/foundation';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SandboxPolicyError, buildSeatbeltProfile, createSeatbeltSandbox } from '@momonga/sandbox';
import type { Sandbox, SandboxPolicy, SandboxedProcess } from '@momonga/sandbox';
import { REAL_PROCESS_TEST_TIMEOUT_MS, killGroupsForCleanup, NEVER_CANCELLED, testPaths, testKernelLock } from '@momonga/testkit';
import { makeTempDir, run } from './helpers.ts';

const created: string[] = [];

const tempDir = (): string => {
  const dir = fs.realpathSync(makeTempDir());
  created.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of created.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const policyFor = (root: string, overrides: Partial<SandboxPolicy> = {}): SandboxPolicy => ({
  writableRoots: [root],
  writeDenied: [],
  protectedSet: EMPTY_PROTECTED_SET,
  writeDeniedLiterals: [],
  fileRules: EMPTY_FILE_RULES,
  readDenied: [],
  network: 'deny',
  ...overrides,
});

const socketRules = (profile: string): string[] => profile.split('\n').filter((line) => line.includes('unix-socket'));

describe('the Unix socket allow list in the Seatbelt profile', () => {
  it('has no network rule at all when the list is empty', async () => {
    const { profile } = await buildSeatbeltProfile(policyFor(tempDir(), { unixSocketAllow: [] }), {}, testPaths());
    expect(profile).not.toContain('network');
  });

  it('allows connecting to each listed path and below it, and never binding', async () => {
    const root = tempDir();
    const listed = path.join(root, 'sockets');
    const { profile, params } = await buildSeatbeltProfile(policyFor(root, { unixSocketAllow: [listed] }), {}, testPaths());
    expect(socketRules(profile)).toEqual(['(allow network-outbound (remote unix-socket (subpath (param "UNIX_SOCKET_ALLOW_0"))))']);
    expect(params['UNIX_SOCKET_ALLOW_0']).toBe(listed);
    expect(profile).not.toContain('network-bind');
    expect(profile).not.toContain('(allow network*)');
  });

  it('denies every read-denied subtree after the allows, so an owned socket stays closed whatever is listed', async () => {
    const root = tempDir();
    const owned = path.join(root, 'owned');
    const { profile, params } = await buildSeatbeltProfile(policyFor(root, { readDenied: [owned], unixSocketAllow: [path.join(owned, 'run'), path.join(root, 'open')] }), {}, testPaths());
    const rules = socketRules(profile);
    expect(rules).toEqual([
      '(allow network-outbound (remote unix-socket (subpath (param "UNIX_SOCKET_ALLOW_0"))))',
      '(allow network-outbound (remote unix-socket (subpath (param "UNIX_SOCKET_ALLOW_1"))))',
      '(deny network-outbound (remote unix-socket (subpath (param "READ_DENIED_0"))))',
    ]);
    expect(params['READ_DENIED_0']).toBe(owned);
  });

  it('refuses a list entry that is not an absolute path', async () => {
    await expect(buildSeatbeltProfile(policyFor(tempDir(), { unixSocketAllow: ['relative/agent.sock'] }), {}, testPaths())).rejects.toThrow(SandboxPolicyError);
  });

  it('keeps every deny of an owned subtree after every allow, for any list in any order', async () => {
    const root = tempDir();
    const owned = [path.join(root, 'a'), path.join(root, 'b')];
    const entries = [path.join(root, 'a', 'run'), path.join(root, 'b'), path.join(root, 'c', 'x.sock'), path.join(root, 'c')];
    const orders = (rest: readonly string[]): string[][] => [[], ...rest.flatMap((first, index) => orders(rest.filter((_, other) => other !== index)).map((tail) => [first, ...tail]))];
    for (const network of ['deny', 'allow'] as const) {
      for (const unixSocketAllow of orders(entries)) {
        const lines = await (await buildSeatbeltProfile(policyFor(root, { readDenied: owned, unixSocketAllow, network }), {}, testPaths())).profile.split('\n');
        const lastAllow = lines.findLastIndex((line) => line.startsWith('(allow network'));
        const denies = lines.flatMap((line, index) => (line.startsWith('(deny network-outbound (remote unix-socket') ? [index] : []));
        if (lastAllow === -1) expect(denies, unixSocketAllow.join(' ')).toEqual([]);
        else {
          expect(denies, unixSocketAllow.join(' ')).toHaveLength(owned.length);
          expect(Math.min(...denies), unixSocketAllow.join(' ')).toBeGreaterThan(lastAllow);
        }
      }
    }
  });
});

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

describe.runIf(process.platform === 'darwin')('the Unix socket allow list under the real sandbox-exec', () => {
  let spawned: SandboxedProcess[] = [];
  let servers: net.Server[] = [];
  let root = '';
  let outside = '';
  let sandbox: Sandbox;
  let hits: string[] = [];

  const connect = async (socket: string, overrides: Partial<SandboxPolicy>): Promise<SandboxedProcess> => {
    const proc = await sandbox.spawn(
      { argv: ['/bin/sh', '-c', `/usr/bin/nc -U '${socket}' </dev/null`], cwd: root, env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' } },
      policyFor(root, overrides),
      new AbortController().signal,
    );
    spawned.push(proc);
    return proc;
  };

  const serve = async (name: string, socket: string): Promise<string> => {
    fs.mkdirSync(path.dirname(socket), { recursive: true });
    const server = net
      .createServer((connection) => {
        hits.push(name);
        connection.on('error', () => undefined);
        connection.end('hi');
      })
      .on('error', () => undefined);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(socket, resolve));
    return socket;
  };

  beforeEach(() => {
    root = tempDir();
    outside = tempDir();
    hits = [];
    sandbox = createSeatbeltSandbox({ lock: testKernelLock(), tmpRoot: tempDir(), killGraceMs: 300 });
  });

  afterEach(async () => {
    try {
      await killGroupsForCleanup(spawned.map((proc) => proc.pgid));
    } finally {
      await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
      spawned = [];
      servers = [];
    }
  });

  it('connects to a socket under a listed path while the network stays denied', async () => {
    const socket = await serve('listed', path.join(outside, 'agents', 'a.sock'));
    const result = await run(await connect(socket, { unixSocketAllow: [path.join(outside, 'agents')] }));
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('hi');
    expect(hits).toEqual(['listed']);
  });

  it('cannot connect to a socket that is under no listed path', async () => {
    const socket = await serve('unlisted', path.join(outside, 'other', 'b.sock'));
    const result = await run(await connect(socket, { unixSocketAllow: [path.join(outside, 'agents')] }));
    expect(result.code).not.toBe(0);
    expect(hits).toEqual([]);
  });

  it('cannot connect to a socket under a read-denied subtree even when it is listed', async () => {
    const owned = path.join(outside, 'owned');
    const socket = await serve('owned', path.join(owned, 'run', 'g.sock'));
    const result = await run(await connect(socket, { readDenied: [owned], unixSocketAllow: [path.join(owned, 'run')] }));
    expect(result.code).not.toBe(0);
    expect(hits).toEqual([]);
  });

  it('cannot reach a TCP listener through the list', async () => {
    const server = net.createServer((connection) => {
      hits.push('tcp');
      connection.end();
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as net.AddressInfo).port;
    const proc = await sandbox.spawn(
      { argv: ['/bin/sh', '-c', `/usr/bin/nc -z -w 2 127.0.0.1 ${port}`], cwd: root, env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' } },
      policyFor(root, { unixSocketAllow: [outside] }),
      new AbortController().signal,
    );
    spawned.push(proc);
    expect((await run(await proc)).code).not.toBe(0);
    expect(hits).toEqual([]);
  });
});
