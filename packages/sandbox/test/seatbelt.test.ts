import fs from 'node:fs';
import { EMPTY_FILE_RULES, EMPTY_PROTECTED_SET } from '@momonga/foundation';
import net from 'node:net';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSeatbeltSandbox, createUnsandboxed } from '@momonga/sandbox';
import type { Sandbox, SandboxPolicy, SandboxedProcess } from '@momonga/sandbox';
import { REAL_PROCESS_TEST_TIMEOUT_MS, killGroupsForCleanup } from '@momonga/testkit';
import { collect, isAlive, makeTempDir, run, waitUntilDead } from './helpers.ts';

const KILL_GRACE_MS = 300;
const BASE_ENV = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' };

describe.runIf(process.platform === 'darwin')('seatbelt sandbox (real sandbox-exec)', { timeout: REAL_PROCESS_TEST_TIMEOUT_MS }, () => {
  let created: string[] = [];
  let spawned: SandboxedProcess[] = [];
  let servers: net.Server[] = [];
  let controllers: AbortController[] = [];
  let root = '';
  let outside = '';
  let tmpRoot = '';
  let sandbox: Sandbox;

  function tempDir(): string {
    const dir = makeTempDir();
    created.push(dir);
    return dir;
  }

  function policy(overrides: Partial<SandboxPolicy> = {}): SandboxPolicy {
    return { writableRoots: [root], writeDenied: [], protectedSet: EMPTY_PROTECTED_SET, writeDeniedLiterals: [], fileRules: EMPTY_FILE_RULES, readDenied: [], network: 'deny', ...overrides };
  }

  function sh(
    script: string,
    overrides: Partial<SandboxPolicy> = {},
    options: { env?: Record<string, string>; using?: Sandbox; signal?: AbortSignal } = {},
  ): SandboxedProcess {
    const controller = new AbortController();
    controllers.push(controller);
    const proc = (options.using ?? sandbox).spawn(
      { argv: ['/bin/sh', '-c', script], cwd: root, env: options.env ?? BASE_ENV },
      policy(overrides),
      options.signal ?? controller.signal,
    );
    spawned.push(proc);
    return proc;
  }

  beforeEach(() => {
    root = tempDir();
    outside = tempDir();
    tmpRoot = tempDir();
    sandbox = createSeatbeltSandbox({ tmpRoot, killGraceMs: KILL_GRACE_MS });
  });

  afterEach(async () => {
    try {
      await killGroupsForCleanup(spawned.map((proc) => proc.pgid));
    } finally {
      for (const controller of controllers) controller.abort();
      await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
      for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
      created = [];
      spawned = [];
      servers = [];
      controllers = [];
    }
  });

  it('reports kind seatbelt', () => {
    expect(sandbox.kind).toBe('seatbelt');
  });

  it('allows writes inside the writable root and denies writes to another directory', async () => {
    const inside = path.join(root, 'inside.txt');
    const ok = await run(sh(`printf hello > '${inside}'`));
    expect(ok.code).toBe(0);
    expect(fs.readFileSync(inside, 'utf8')).toBe('hello');

    const target = path.join(outside, 'escaped.txt');
    const denied = await run(sh(`printf nope > '${target}'`));
    expect(denied.code).not.toBe(0);
    expect(denied.stderr).toMatch(/Operation not permitted/);
    expect(fs.existsSync(target)).toBe(false);
  });

  it('denies writes to protected paths inside the root while still allowing reads', async () => {
    fs.mkdirSync(path.join(root, '.git', 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(root, '.mcp.json'), '{"original":true}');
    fs.writeFileSync(path.join(root, '.git', 'hooks', 'pre-commit'), 'original-hook');
    const overrides = { writeDenied: [path.join(root, '.git', 'hooks'), path.join(root, '.mcp.json')] };

    const hook = await run(sh(`printf evil > .git/hooks/pre-commit`, overrides));
    expect(hook.code).not.toBe(0);
    expect(hook.stderr).toMatch(/Operation not permitted/);
    expect(fs.readFileSync(path.join(root, '.git', 'hooks', 'pre-commit'), 'utf8')).toBe('original-hook');

    const newHook = await run(sh(`printf evil > .git/hooks/post-checkout`, overrides));
    expect(newHook.code).not.toBe(0);
    expect(fs.existsSync(path.join(root, '.git', 'hooks', 'post-checkout'))).toBe(false);

    const mcp = await run(sh(`printf evil > .mcp.json`, overrides));
    expect(mcp.code).not.toBe(0);
    expect(fs.readFileSync(path.join(root, '.mcp.json'), 'utf8')).toBe('{"original":true}');

    const read = await run(sh(`cat .mcp.json; cat .git/hooks/pre-commit`, overrides));
    expect(read.code).toBe(0);
    expect(read.stdout).toBe('{"original":true}original-hook');
  });

  it('denies writes to defaultProtectedPaths-style entries that do not exist yet', async () => {
    const overrides = { writeDenied: [path.join(root, '.envrc')] };
    const result = await run(sh(`printf evil > .envrc`, overrides));
    expect(result.code).not.toBe(0);
    expect(fs.existsSync(path.join(root, '.envrc'))).toBe(false);
  });

  it('denies reads under readDenied and allows reads elsewhere', async () => {
    const secretDir = path.join(outside, 'secrets');
    fs.mkdirSync(secretDir);
    fs.writeFileSync(path.join(secretDir, 'token'), 'top-secret');
    fs.writeFileSync(path.join(outside, 'public'), 'visible');

    const denied = await run(sh(`cat '${path.join(secretDir, 'token')}'`, { readDenied: [secretDir] }));
    expect(denied.code).not.toBe(0);
    expect(denied.stdout).not.toContain('top-secret');
    expect(denied.stderr).toMatch(/Operation not permitted/);

    const allowed = await run(sh(`cat '${path.join(outside, 'public')}'`, { readDenied: [secretDir] }));
    expect(allowed.code).toBe(0);
    expect(allowed.stdout).toBe('visible');
  });

  it('works with a root containing quote, paren, semicolon, newline and non-ASCII characters without rule injection', async () => {
    root = path.join(tempDir(), 'a"b)c;d\n(allow default)-日本');
    fs.mkdirSync(root);
    const inside = await run(sh(`printf ok > ./inside.txt`));
    expect(inside.code).toBe(0);
    expect(fs.readFileSync(path.join(root, 'inside.txt'), 'utf8')).toBe('ok');

    const target = path.join(outside, 'escaped.txt');
    const escaped = await run(sh(`printf nope > '${target}'`));
    expect(escaped.code).not.toBe(0);
    expect(fs.existsSync(target)).toBe(false);
  });

  it('gives each spawn a private writable TMPDIR under tmpRoot and removes it after exit', async () => {
    const result = await run(sh(`printf %s "$TMPDIR"; printf data > "$TMPDIR/scratch"`));
    expect(result.code).toBe(0);
    const tmpdir = result.stdout;
    expect(tmpdir.startsWith(fs.realpathSync(tmpRoot) + path.sep)).toBe(true);
    expect(fs.existsSync(tmpdir)).toBe(false);

    const second = await run(sh(`printf %s "$TMPDIR"`));
    expect(second.stdout).not.toBe(tmpdir);
  });

  it('denies all network including localhost when network is deny, and allows it when allow', async () => {
    let connections = 0;
    const server = net.createServer((socket) => {
      connections += 1;
      socket.end();
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as net.AddressInfo).port;

    const denied = await run(sh(`/usr/bin/nc -z -w 2 127.0.0.1 ${port}`, { network: 'deny' }));
    expect(denied.code).not.toBe(0);
    expect(connections).toBe(0);

    const allowed = await run(sh(`/usr/bin/nc -z -w 2 127.0.0.1 ${port}`, { network: 'allow' }));
    expect(allowed.code).toBe(0);
    await expect.poll(() => connections).toBe(1);
  });

  it('kills the whole process group on abort', async () => {
    const controller = new AbortController();
    const proc = sh(`sleep 30 & printf '%s\\n' "$!"; sleep 30`, {}, { signal: controller.signal });
    expect(proc.pgid).toBe(proc.pid);
    const iterator = proc.stdout[Symbol.asyncIterator]();
    const first = await iterator.next();
    const grandchild = Number(Buffer.from(first.value ?? new Uint8Array()).toString('utf8').trim());
    expect(Number.isInteger(grandchild) && grandchild > 0).toBe(true);
    expect(isAlive(grandchild)).toBe(true);

    controller.abort();
    const exit = await proc.exited;
    expect(exit.killedBy).toBe('abort');
    expect(await waitUntilDead([proc.pid, grandchild], KILL_GRACE_MS + 1000)).toBe(true);
  });

  it('SIGKILLs a group that ignores SIGTERM after killGraceMs', async () => {
    const controller = new AbortController();
    const proc = sh(`trap '' TERM; printf 'ready\\n'; sleep 30`, {}, { signal: controller.signal });
    const iterator = proc.stdout[Symbol.asyncIterator]();
    await iterator.next();
    const started = Date.now();
    controller.abort();
    const exit = await proc.exited;
    const elapsed = Date.now() - started;
    expect(exit.killedBy).toBe('grace-kill');
    expect(exit.signal).toBe('SIGKILL');
    expect(elapsed).toBeGreaterThanOrEqual(KILL_GRACE_MS - 20);
    expect(elapsed).toBeLessThan(KILL_GRACE_MS + 2000);
    expect(await waitUntilDead([proc.pid], 1000)).toBe(true);
  });

  it('streams stdout and stderr including more than 1 MiB without deadlock', async () => {
    const bytes = 3 * 1024 * 1024;
    const result = await run(sh(`head -c ${bytes} /dev/zero | tr '\\0' 'a'; printf 'to-stderr' >&2`));
    expect(result.code).toBe(0);
    expect(result.stdout.length).toBe(bytes);
    expect(result.stdout).toMatch(/^a+$/);
    expect(result.stderr).toBe('to-stderr');
  });

  it('streams large stderr concurrently with stdout', async () => {
    const bytes = 2 * 1024 * 1024;
    const result = await run(sh(`head -c ${bytes} /dev/zero >&2; printf done`));
    expect(result.code).toBe(0);
    expect(result.stderr.length).toBe(bytes);
    expect(result.stdout).toBe('done');
  });

  it('reports exit codes and terminating signals', async () => {
    const coded = await run(sh(`exit 7`));
    expect(coded.code).toBe(7);
    expect(coded.signal).toBeNull();
    expect(coded.killedBy).toBeUndefined();

    const signalled = await run(sh(`kill -TERM $$`));
    expect(signalled.code).toBeNull();
    expect(signalled.signal).toBe('SIGTERM');
    expect(signalled.killedBy).toBeUndefined();
  });

  it('passes only the provided env plus TMPDIR', async () => {
    const previous = process.env['MM_SANDBOX_PARENT_ONLY'];
    process.env['MM_SANDBOX_PARENT_ONLY'] = 'leaked';
    try {
      const result = await run(sh(`/usr/bin/env`, {}, { env: { ...BASE_ENV, MM_GIVEN: 'given-value' } }));
      expect(result.code).toBe(0);
      const names = result.stdout
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => line.slice(0, line.indexOf('=')));
      expect(result.stdout).toContain('MM_GIVEN=given-value');
      expect(names).not.toContain('MM_SANDBOX_PARENT_ONLY');
      expect(names.filter((name) => !['PWD', 'SHLVL', '_'].includes(name)).sort()).toEqual(
        ['MM_GIVEN', 'PATH', 'TMPDIR'].sort(),
      );
    } finally {
      if (previous === undefined) delete process.env['MM_SANDBOX_PARENT_ONLY'];
      else process.env['MM_SANDBOX_PARENT_ONLY'] = previous;
    }
  });

  it('the unsandboxed runner can write to the outside dir, proving the outside check is meaningful', async () => {
    const unsandboxed = createUnsandboxed();
    expect(unsandboxed.kind).toBe('none');
    const target = path.join(outside, 'written.txt');
    const result = await run(sh(`printf free > '${target}'`, {}, { using: unsandboxed }));
    expect(result.code).toBe(0);
    expect(fs.readFileSync(target, 'utf8')).toBe('free');
  });

  it('throws naming a missing sandbox-exec path', () => {
    const missing = path.join(outside, 'no-such-sandbox-exec');
    expect(() => createSeatbeltSandbox({ sandboxExecPath: missing, tmpRoot, killGraceMs: KILL_GRACE_MS })).toThrow(
      missing,
    );
  });

  it('throws naming a writable root that does not exist', () => {
    const missingRoot = path.join(outside, 'missing-root');
    expect(() => sh('true', { writableRoots: [missingRoot] })).toThrow(missingRoot);
  });

  it('throws naming a relative writable root', () => {
    expect(() => sh('true', { writableRoots: ['relative/root'] })).toThrow('relative/root');
  });

  it('streams stdout before the process exits', async () => {
    const controller = new AbortController();
    const proc = sh(`printf early; sleep 30`, {}, { signal: controller.signal });
    const iterator = proc.stdout[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(Buffer.from(first.value ?? new Uint8Array()).toString('utf8')).toBe('early');
    controller.abort();
    await proc.exited;
    await collect({ [Symbol.asyncIterator]: () => iterator });
  });
});
