import { spawnSync } from 'node:child_process';
import { EMPTY_FILE_RULES, EMPTY_PROTECTED_SET, defaultProtectedPaths } from '@momonga/foundation';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildSeatbeltProfile, createSeatbeltSandbox } from '@momonga/sandbox';
import type { Sandbox, SandboxPolicy, SandboxedProcess } from '@momonga/sandbox';
import { REAL_PROCESS_TEST_TIMEOUT_MS, killGroupsForCleanup, killPidsForCleanup } from '@momonga/testkit';
import { isAlive, makeTempDir, run, waitUntilDead } from './helpers.ts';

const KILL_GRACE_MS = 300;
const BASE_ENV = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' };

describe.runIf(process.platform === 'darwin')('seatbelt sandbox hardening (real sandbox-exec)', { timeout: REAL_PROCESS_TEST_TIMEOUT_MS }, () => {
  let created: string[] = [];
  let spawned: SandboxedProcess[] = [];
  let servers: net.Server[] = [];
  let strayPids: number[] = [];
  let root = '';
  let outside = '';
  let sandbox: Sandbox;

  function tempDir(): string {
    const dir = fs.realpathSync(makeTempDir());
    created.push(dir);
    return dir;
  }

  function sh(script: string, overrides: Partial<SandboxPolicy> = {}): SandboxedProcess {
    const proc = sandbox.spawn(
      { argv: ['/bin/sh', '-c', script], cwd: root, env: BASE_ENV },
      { writableRoots: [root], writeDenied: defaultProtectedPaths(root), protectedSet: EMPTY_PROTECTED_SET, writeDeniedLiterals: [], fileRules: EMPTY_FILE_RULES, readDenied: [], network: 'deny', ...overrides },
      new AbortController().signal,
    );
    spawned.push(proc);
    return proc;
  }

  function protectedFixture(): void {
    fs.mkdirSync(path.join(root, '.git', 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(root, '.git', 'hooks', 'x'), 'original-hook');
    fs.writeFileSync(path.join(root, '.mcp.json'), 'original-mcp');
  }

  function listen(server: net.Server, target: number | string): Promise<void> {
    servers.push(server);
    return new Promise<void>((resolve) => {
      if (typeof target === 'number') server.listen(target, '127.0.0.1', resolve);
      else server.listen(target, resolve);
    });
  }

  beforeEach(() => {
    root = tempDir();
    outside = tempDir();
    sandbox = createSeatbeltSandbox({ tmpRoot: tempDir(), killGraceMs: KILL_GRACE_MS });
  });

  afterEach(async () => {
    killPidsForCleanup(strayPids);
    try {
      await killGroupsForCleanup(spawned.map((proc) => proc.pgid));
    } finally {
      await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
      for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
      created = [];
      spawned = [];
      servers = [];
      strayPids = [];
    }
  });

  it('terminates background processes left behind by the leader before exited resolves', async () => {
    const proc = sh(`(sleep 30 &) ; sleep 300 & echo $! > pids; echo started`);
    const result = await run(proc);
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe('started');
    const backgrounded = Number(fs.readFileSync(path.join(root, 'pids'), 'utf8').trim());
    expect(Number.isInteger(backgrounded) && backgrounded > 1).toBe(true);
    expect(isAlive(backgrounded)).toBe(false);
    expect(() => process.kill(-proc.pgid, 0)).toThrow(/ESRCH/);
  });

  it('removes the private TMPDIR only after leftover background processes are gone', async () => {
    const result = await run(sh(`printf %s "$TMPDIR"; (sleep 30 &)`));
    expect(result.code).toBe(0);
    expect(fs.existsSync(result.stdout)).toBe(false);
  });

  it('does not terminate descendants that call setsid (known limitation: Seatbelt cannot deny setsid)', async () => {
    const script = `perl -e 'use POSIX; setsid(); open(F, ">pid"); print F $$; close F; my $end = time + 4; sleep 1 while time < $end' >/dev/null 2>&1 & sleep 0.5; echo started`;
    const result = await run(sh(script));
    expect(result.code).toBe(0);
    const escaped = Number(fs.readFileSync(path.join(root, 'pid'), 'utf8'));
    strayPids.push(escaped);
    expect(isAlive(escaped)).toBe(true);
    killPidsForCleanup([escaped]);
    expect(await waitUntilDead([escaped], 2000)).toBe(true);
  });

  it('denies xattr, chflags and chmod on protected paths', async () => {
    protectedFixture();
    const result = await run(
      sh(
        `xattr -w user.test v .mcp.json; xattr -w user.test v .git/hooks/x; chflags hidden .mcp.json; chflags hidden .git/hooks/x; chmod 777 .mcp.json .git/hooks/x`,
      ),
    );
    expect(result.stderr.match(/Operation not permitted/g)?.length).toBe(6);
    expect(fs.statSync(path.join(root, '.mcp.json')).mode & 0o777).toBe(0o644);
    expect(fs.statSync(path.join(root, '.git', 'hooks', 'x')).mode & 0o777).toBe(0o644);
    const attrs = await run(sh(`xattr -l .mcp.json .git/hooks/x`));
    expect(attrs.stdout).not.toContain('user.test');
  });

  it('denies clonefile into protected paths and outside the root', async () => {
    protectedFixture();
    fs.writeFileSync(path.join(root, 'payload'), 'evil');
    const result = await run(
      sh(`cp -c payload .mcp.json; cp -c payload .git/hooks/y; cp -c payload '${path.join(outside, 'z')}'`),
    );
    expect(result.code).not.toBe(0);
    expect(fs.readFileSync(path.join(root, '.mcp.json'), 'utf8')).toBe('original-mcp');
    expect(fs.existsSync(path.join(root, '.git', 'hooks', 'y'))).toBe(false);
    expect(fs.existsSync(path.join(outside, 'z'))).toBe(false);
  });

  it('denies ditto to outside the root', async () => {
    fs.writeFileSync(path.join(root, 'payload'), 'evil');
    const result = await run(sh(`ditto payload '${path.join(outside, 'd')}'`));
    expect(result.code).not.toBe(0);
    expect(fs.existsSync(path.join(outside, 'd'))).toBe(false);
  });

  it('does not let osascript or open perform writes outside the root', async () => {
    const target = path.join(outside, 'osa');
    const viaOsascript = await run(sh(`osascript -e 'do shell script "touch ${target}"'`));
    expect(viaOsascript.code).not.toBe(0);
    expect(fs.existsSync(target)).toBe(false);
    fs.writeFileSync(path.join(root, 'doc.txt'), 'x');
    const viaOpen = await run(sh(`open -a TextEdit doc.txt`));
    expect(viaOpen.code).not.toBe(0);
  });

  it('cannot run crontab or at, and cannot inspect other processes', async () => {
    const cron = await run(sh(`crontab -l`));
    expect(cron.code).not.toBe(0);
    expect(cron.stderr).toMatch(/Operation not permitted/);
    const at = await run(sh(`at -l`));
    expect(at.code).not.toBe(0);
    expect(at.stderr).toMatch(/Operation not permitted/);
    const vmmap = await run(sh(`vmmap $PPID`));
    expect(vmmap.stderr).toMatch(/vmmap/);
    expect(vmmap.stdout).not.toMatch(/REGION TYPE/);
  });

  it('denies writes through a writable root whose path component was replaced by a symlink after canonicalization', async () => {
    const parent = tempDir();
    const work = path.join(parent, 'work');
    fs.mkdirSync(work);
    const { profile, params } = buildSeatbeltProfile({
      writableRoots: [work],
      writeDenied: [], protectedSet: EMPTY_PROTECTED_SET, writeDeniedLiterals: [], fileRules: EMPTY_FILE_RULES,
      readDenied: [],
      network: 'deny',
    });
    fs.rmSync(work, { recursive: true });
    fs.symlinkSync(outside, work);
    const args = Object.entries(params).flatMap(([name, value]) => ['-D', `${name}=${value}`]);
    const result = spawnSync(
      '/usr/bin/sandbox-exec',
      ['-p', profile, ...args, '--', '/bin/sh', '-c', `echo evil > '${work}/f'`],
      { encoding: 'utf8', cwd: outside },
    );
    expect(result.status).not.toBe(0);
    expect(fs.existsSync(path.join(outside, 'f'))).toBe(false);
  });

  describe('network allow', () => {
    it('resolves localhost without any mach-lookup', async () => {
      let connections = 0;
      const server = net.createServer((socket) => {
        connections += 1;
        socket.end();
      });
      await listen(server, 0);
      const port = (server.address() as net.AddressInfo).port;
      const result = await run(sh(`/usr/bin/nc -z -w 2 localhost ${port}`, { network: 'allow' }));
      expect(result.code).toBe(0);
      await expect.poll(() => connections).toBe(1);
    });

    it('denies connecting to unix sockets under readDenied but allows other unix sockets', async () => {
      const secrets = path.join(outside, 'secrets');
      const open = path.join(outside, 'open');
      fs.mkdirSync(secrets);
      fs.mkdirSync(open);
      const hits: string[] = [];
      const serve = (name: string): net.Server =>
        net.createServer((socket) => {
          hits.push(name);
          socket.on('error', () => undefined);
          socket.end('hi');
        }).on('error', () => undefined);
      await listen(serve('secret'), path.join(secrets, 'gateway.sock'));
      await listen(serve('open'), path.join(open, 'other.sock'));

      const blocked = await run(
        sh(`/usr/bin/nc -U '${path.join(secrets, 'gateway.sock')}' </dev/null`, { network: 'allow', readDenied: [secrets] }),
      );
      expect(blocked.code).not.toBe(0);
      expect(hits).not.toContain('secret');

      const permitted = await run(
        sh(`/usr/bin/nc -U '${path.join(open, 'other.sock')}' </dev/null`, { network: 'allow', readDenied: [secrets] }),
      );
      expect(permitted.code).toBe(0);
      await expect.poll(() => hits).toContain('open');
    });

    it('denies unix sockets under readDenied when network is deny too', async () => {
      const secrets = path.join(outside, 'secrets');
      fs.mkdirSync(secrets);
      let hit = false;
      await listen(
        net.createServer((socket) => {
          hit = true;
          socket.on('error', () => undefined);
          socket.end();
        }),
        path.join(secrets, 'gateway.sock'),
      );
      const result = await run(
        sh(`/usr/bin/nc -U '${path.join(secrets, 'gateway.sock')}' </dev/null`, { network: 'deny', readDenied: [secrets] }),
      );
      expect(result.code).not.toBe(0);
      expect(hit).toBe(false);
    });
  });
});
