import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_FILE_RULES, EMPTY_PROTECTED_SET, momongaLayout } from '@momonga/foundation';
import { DEFAULT_BWRAP_PATH, childProtectionFor, createUnsandboxed } from '@momonga/sandbox';
import type { SandboxPolicy, SandboxedProcess } from '@momonga/sandbox';
import { createTempDir, killGroupsForCleanup, REAL_PROCESS_TEST_TIMEOUT_MS } from '@momonga/testkit';
import { makeTempDir, run } from './helpers.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const OPEN_POLICY: SandboxPolicy = { writableRoots: [], writeDenied: [], writeDeniedLiterals: [], readDenied: [], network: 'allow', fileRules: EMPTY_FILE_RULES, protectedSet: EMPTY_PROTECTED_SET };

const BASE_ENV = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' };
const PROTECTED_HOST = process.platform === 'darwin' || (process.platform === 'linux' && fs.existsSync(DEFAULT_BWRAP_PATH));

describe.runIf(PROTECTED_HOST)('a sandbox none child under the protection of the home (real platform sandbox)', () => {
  let created: string[] = [];
  let spawned: SandboxedProcess[] = [];
  let servers: net.Server[] = [];
  let home = '';
  let work = '';

  const temp = (): string => {
    const dir = fs.realpathSync(makeTempDir());
    created.push(dir);
    return dir;
  };

  const sh = async (script: string, scratch?: string): Promise<{ code: number | null; stdout: string }> => {
    const protection = childProtectionFor({ sandbox: 'none', home, platform: process.platform, env: {}, bubblewrap: process.platform === 'linux' });
    const sandbox = createUnsandboxed({ killGraceMs: 300, protection, platform: process.platform });
    const proc = await sandbox.spawn({ argv: ['/bin/sh', '-c', script], cwd: work, env: BASE_ENV, ...(scratch === undefined ? {} : { tmpDir: scratch }) }, OPEN_POLICY, new AbortController().signal);
    spawned.push(proc);
    return run(proc);
  };

  beforeEach(() => {
    home = temp();
    work = temp();
    fs.mkdirSync(momongaLayout(home, process.platform, {}).root, { recursive: true });
  });

  afterEach(async () => {
    try {
      await killGroupsForCleanup(spawned.map((proc) => proc.pgid));
    } finally {
      await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
      for (const dir of created.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
      spawned = [];
      servers = [];
    }
  });

  it('cannot read a file in the home and reads a file outside it', async () => {
    const root = momongaLayout(home, process.platform, {}).root;
    fs.writeFileSync(path.join(root, 'x'), 'secret');
    fs.writeFileSync(path.join(work, 'y'), 'open');
    const inside = await sh(`cat '${path.join(root, 'x')}'`);
    expect(inside.stdout).not.toContain('secret');
    expect((await sh(`cat '${path.join(work, 'y')}'`)).stdout).toBe('open');
  });

  it('leaves the real home untouched by a write of the command', async () => {
    const root = momongaLayout(home, process.platform, {}).root;
    await sh(`echo planted > '${path.join(root, 'planted')}'`);
    expect(fs.existsSync(path.join(root, 'planted'))).toBe(false);
  });

  it('writes in its own scratch folder inside the protected area', async () => {
    const scratch = path.join(momongaLayout(home, process.platform, {}).tmp.sessions, 's1');
    fs.mkdirSync(scratch, { recursive: true });
    const result = await sh(`echo kept > "$TMPDIR/k" && cat "$TMPDIR/k"`, scratch);
    expect(result.stdout.trim()).toBe('kept');
    expect(fs.readFileSync(path.join(scratch, 'k'), 'utf8').trim()).toBe('kept');
  });

  it.runIf(process.platform === 'darwin')('cannot connect to a socket under the home', async () => {
    const socketHome = createTempDir({ asHome: true });
    created.push(socketHome);
    home = socketHome;
    const root = momongaLayout(home, process.platform, {}).root;
    fs.mkdirSync(root, { recursive: true });
    let hits = 0;
    const server = net.createServer((connection) => {
      hits += 1;
      connection.end('hi');
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(path.join(root, 's.sock'), resolve));
    const result = await sh(`/usr/bin/nc -U '${path.join(root, 's.sock')}' </dev/null`);
    expect(result.code).not.toBe(0);
    expect(hits).toBe(0);
  });

  it('reaches the network', async () => {
    let hits = 0;
    const server = net.createServer((connection) => {
      hits += 1;
      connection.end();
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as net.AddressInfo).port;
    const connect = `require('node:net').connect(${port}, '127.0.0.1').on('connect', () => process.exit(0)).on('error', () => process.exit(1))`;
    expect((await sh(`'${process.execPath}' -e "${connect}"`)).code).toBe(0);
    await expect.poll(() => hits).toBe(1);
  });
});
