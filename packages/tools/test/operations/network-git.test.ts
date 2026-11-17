import { execFileSync } from '@momonga/testkit/child-process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { REAL_PROCESS_TEST_TIMEOUT_MS } from '@momonga/testkit';
import type { ArgvRunner, ForgeAccess } from '@momonga/tools';
import { gitEnvironment, gitProxyEnvironment } from '@momonga/tools';
import { contextFor, countingRunner, makeGitWorld, onCleanup, operationTool, partsOf, settle, shaOfRemote } from './support.ts';
import type { GitWorld } from './support.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const PUSH = { remote: 'origin', branch: 'main' };

const effective = (world: GitWorld, env: Readonly<Record<string, string>>, ...args: string[]): string => {
  try {
    return execFileSync('git', ['config', ...args], { cwd: world.work, env: { ...env }, encoding: 'utf8' }).trim();
  } catch {
    return '<unset>';
  }
};

describe('the environment of a git process that reaches the network', () => {
  const DESTINATION = 'https://forge.example/acme/widgets.git';

  const hostileWorld = (): GitWorld => {
    const world = makeGitWorld();
    world.git(world.work, 'config', 'http.sslVerify', 'false');
    world.git(world.work, 'config', `http.${DESTINATION}.sslVerify`, 'false');
    world.git(world.work, 'config', 'http.extraHeader', 'X-Planted: 1');
    world.git(world.work, 'config', `http.${DESTINATION}.extraHeader`, 'X-Planted: url');
    world.git(world.work, 'config', 'http.curloptResolve', 'forge.example:443:203.0.113.9');
    world.git(world.work, 'config', 'http.followRedirects', 'true');
    world.git(world.work, 'config', 'http.cookieFile', '/planted/cookies');
    world.git(world.work, 'config', 'http.saveCookies', 'true');
    world.git(world.work, 'config', 'core.hooksPath', '.planted-hooks');
    world.git(world.work, 'config', 'core.sshCommand', '/planted/ssh');
    world.git(world.work, 'config', 'credential.helper', '/planted/helper');
    return world;
  };

  it('sets aside what the repository configures for the transport, for the exact destination and in general', () => {
    const world = hostileWorld();
    const env = gitEnvironment(world.env, { mode: 'network', destinations: [DESTINATION], rewrites: [] });
    expect(effective(world, env, '--get-urlmatch', 'http.sslVerify', DESTINATION)).toBe('true');
    expect(effective(world, env, '--get-urlmatch', 'http.extraHeader', DESTINATION)).toBe('');
    expect(effective(world, env, '--get-urlmatch', 'http.curloptResolve', DESTINATION)).toBe('');
    expect(effective(world, env, '--get-urlmatch', 'http.followRedirects', DESTINATION)).toBe('initial');
    expect(effective(world, env, '--get-urlmatch', 'http.cookieFile', DESTINATION)).toBe('');
    expect(effective(world, env, '--get-urlmatch', 'http.saveCookies', DESTINATION)).toBe('false');
    expect(effective(world, env, 'core.hooksPath')).toBe('/dev/null');
    expect(effective(world, env, 'core.sshCommand')).toBe('/dev/null');
    expect(effective(world, env, 'credential.helper')).toBe('');
  });

  it('allows only the protocol of each destination', () => {
    const world = makeGitWorld();
    const remote = gitEnvironment(world.env, { mode: 'network', destinations: [DESTINATION], rewrites: [] });
    expect(effective(world, remote, 'protocol.allow')).toBe('never');
    expect(effective(world, remote, 'protocol.https.allow')).toBe('always');
    expect(effective(world, remote, 'protocol.file.allow')).toBe('never');
    expect(effective(world, remote, 'protocol.ssh.allow')).toBe('never');
    expect(effective(world, remote, 'protocol.ext.allow')).toBe('never');
    const local = gitEnvironment(world.env, { mode: 'network', destinations: ['/srv/a.git', 'file:///srv/b.git'], rewrites: [] });
    expect(effective(world, local, 'protocol.file.allow')).toBe('always');
    expect(effective(world, local, 'protocol.https.allow')).toBe('never');
  });

  it('names the proxy of the call for the destination, over a proxy the repository configures', () => {
    const world = makeGitWorld();
    world.git(world.work, 'config', 'http.proxy', 'http://planted.invalid:9');
    world.git(world.work, 'config', `http.${DESTINATION}.proxy`, 'http://planted.invalid:9');
    const env = gitProxyEnvironment(gitEnvironment(world.env, { mode: 'network', destinations: [DESTINATION], rewrites: [] }), 'http://127.0.0.1:4000', [DESTINATION]);
    expect(effective(world, env, '--get-urlmatch', 'http.proxy', DESTINATION)).toBe('http://127.0.0.1:4000');
  });

  it('keeps the hooks and the transport settings of the repository for a local step, and drops inherited configuration in every mode', () => {
    const world = hostileWorld();
    const inherited = { ...world.env, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: '/inherited', GIT_SSH_COMMAND: '/inherited/ssh' };
    const local = gitEnvironment(inherited, { mode: 'local' });
    expect(effective(world, local, 'core.hooksPath')).toBe('.planted-hooks');
    expect(local['GIT_SSH_COMMAND']).toBeUndefined();
    expect(local['GIT_TERMINAL_PROMPT']).toBe('0');
    const read = gitEnvironment(inherited, { mode: 'read' });
    expect(effective(world, read, 'core.hooksPath')).toBe('/dev/null');
    expect(effective(world, read, 'protocol.file.allow')).toBe('never');
  });
});

type Seen = { url: string; authorization: string | undefined; planted: string | undefined };

const startAskingServer = async (): Promise<{ origin: string; host: string; seen: Seen[] }> => {
  const seen: Seen[] = [];
  const server = http.createServer((request, response) => {
    const planted = request.headers['x-planted'];
    seen.push({ url: request.url ?? '', authorization: request.headers.authorization, planted: Array.isArray(planted) ? planted.join(',') : planted });
    if (request.headers.authorization === undefined) response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="forge"' });
    else response.writeHead(404);
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  onCleanup(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const { port } = server.address() as AddressInfo;
  return { origin: `http://127.0.0.1:${port}`, host: `127.0.0.1:${port}`, seen };
};

describe('a network probe that carries the credential, in a repository that configures programs and headers', () => {
  it('asks only the askpass of the call: no credential helper and no askpass of the repository runs, and no header of the repository is sent', async () => {
    const server = await startAskingServer();
    const world = makeGitWorld();
    const fired = path.join(world.base, 'fired');
    const planted = path.join(world.base, 'planted');
    fs.writeFileSync(planted, `#!/bin/sh\necho "$0 $*" >> ${fired}\n`, { mode: 0o755 });
    world.git(world.work, 'remote', 'set-url', 'origin', `${server.origin}/acme/widgets.git`);
    world.git(world.work, 'config', 'credential.helper', planted);
    world.git(world.work, 'config', `credential.${server.origin}.helper`, planted);
    world.git(world.work, 'config', 'core.askPass', planted);
    world.git(world.work, 'config', 'http.extraHeader', 'X-Planted: 1');
    world.git(world.work, 'config', `http.${server.origin}/.extraHeader`, 'X-Planted: url');
    world.write('a.txt', 'one\n');
    world.commitAll('first');
    const forge: ForgeAccess = { request: async () => Promise.reject(new Error('no forge request is expected')), gitCredential: async () => ({ origin: server.origin, username: 'x-access-token', password: 'fake-git-credential-for-tests' }) , gitDestination: () => undefined };
    const runner = countingRunner();
    await settle(async () => {
      await partsOf(operationTool('GitPush', { runArgv: runner.run, forge }), PUSH, contextFor(world.work, world.env)).prepare();
      return { status: 'completed', output: '' };
    });
    expect(runner.calls.some((argv) => argv.includes('ls-remote'))).toBe(true);
    expect(server.seen.some((request) => request.authorization !== undefined)).toBe(true);
    expect(server.seen.map((request) => request.planted)).toEqual(server.seen.map(() => undefined));
    expect(fs.existsSync(fired)).toBe(false);
  });
});

describe('a setting of the repository that changes who vouches for the forge', () => {
  const httpsWorld = (): GitWorld => {
    const world = makeGitWorld();
    world.git(world.work, 'remote', 'set-url', 'origin', 'https://forge.example/acme/widgets.git');
    return world;
  };

  it.each(['http.sslCAInfo', 'http.https://forge.example/.sslCAPath'])('refuses GitPush when the repository sets %s, names the key and runs nothing on the network', async (key) => {
    const world = httpsWorld();
    world.git(world.work, 'config', key, '/planted/ca');
    const runner = countingRunner();
    const outcome = await settle(async () => {
      await partsOf(operationTool('GitPush', { runArgv: runner.run }), PUSH, contextFor(world.work, world.env)).prepare();
      return { status: 'completed', output: '' };
    });
    expect(outcome.status).toBe('threw');
    expect(outcome.output).toContain(key.toLowerCase().startsWith('http.https') ? 'sslcapath' : 'sslcainfo');
    expect(outcome.output).toContain('git config --global');
    expect(runner.calls.some((argv) => argv.includes('ls-remote') || argv.includes('push'))).toBe(false);
  });

  it('does not refuse for the same key in the configuration of the person', async () => {
    const world = httpsWorld();
    fs.appendFileSync(world.env['GIT_CONFIG_GLOBAL'] as string, '[http]\n\tsslCAInfo = /own/ca\n');
    const tool = operationTool('GitPush', { runArgv: countingRunner().run });
    const ctx = contextFor(world.work, world.env);
    expect(await tool.gateFacts?.(PUSH, ctx, { signal: ctx.signal, env: ctx.env, context: ctx })).toMatchObject({ destinations: ['https://forge.example/acme/widgets.git'] });
  });
});

describe('a path-valued http key git cannot take empty is refused before any credentialed process', () => {
  const httpsWorld = (): GitWorld => {
    const world = makeGitWorld();
    world.git(world.work, 'remote', 'set-url', 'origin', 'https://forge.example/acme/widgets.git');
    return world;
  };

  it.each([
    ['GitPush', { remote: 'origin', branch: 'main' }],
    ['GitFetch', { remote: 'origin', branch: 'main' }],
  ])('%s refuses a repository setting of each key, and no credentialed git runs', async (name, input) => {
    for (const key of ['http.sslCert', 'http.sslCAPath', 'http.pinnedPubkey', 'http.https://forge.example/.sslCert', 'http.https://forge.example/.pinnedPubkey']) {
      const world = httpsWorld();
      world.git(world.work, 'config', key, '/planted/file.pem');
      const runner = countingRunner();
      const outcome = await settle(async () => {
        await partsOf(operationTool(name, { runArgv: runner.run }), input, contextFor(world.work, world.env)).prepare();
        return { status: 'completed', output: '' };
      });
      expect(outcome.status, key).toBe('threw');
      expect(outcome.output, key).toContain(key.split('.').at(-1)?.toLowerCase() ?? '');
      expect(runner.credentialed, key).toEqual(runner.credentialed.map(() => false));
      expect(runner.calls.some((argv) => argv.includes('ls-remote') || argv.includes('push') || argv.includes('fetch')), key).toBe(false);
    }
  });
});

describe('what an operation reads about the repository before its permission is decided', () => {
  it('reads through the argv runner of the operations, with the read-only environment and no network', async () => {
    const world = makeGitWorld();
    world.git(world.work, 'remote', 'set-url', 'origin', `file://${world.bare}`);
    const runner = countingRunner();
    const tool = operationTool('GitPush', { runArgv: runner.run });
    const ctx = contextFor(world.work, world.env);
    await tool.gateFacts?.(PUSH, ctx, { signal: ctx.signal, env: ctx.env, context: ctx });
    expect(runner.calls.map((argv) => argv.slice(0, 3).join(' '))).toEqual(expect.arrayContaining(['git rev-parse --show-toplevel', 'git remote get-url']));
    expect(runner.credentialed).toEqual(runner.calls.map(() => false));
    for (const env of runner.environments) expect(effective(world, env, 'core.hooksPath')).toBe('/dev/null');
  });
});

describe('the pre-push hook of a repository', () => {
  const hookWorld = (hooksPath?: string) => {
    const world = makeGitWorld();
    world.git(world.work, 'remote', 'set-url', 'origin', `file://${world.bare}`);
    world.write('a.txt', 'one\n');
    const head = world.commitAll('first');
    const directory = hooksPath === undefined ? path.join(world.work, '.git', 'hooks') : path.join(world.work, hooksPath);
    if (hooksPath !== undefined) world.git(world.work, 'config', 'core.hooksPath', hooksPath);
    fs.mkdirSync(directory, { recursive: true });
    const record = path.join(world.base, 'hook-ran');
    const write = (body: string, mode = 0o755): void => fs.writeFileSync(path.join(directory, 'pre-push'), `#!/bin/sh\n${body}\n`, { mode });
    return { world, head, record, write };
  };

  const recording = (record: string): string =>
    [`echo "args: $1 $2" >> ${record}`, `echo "remote refs: $(git ls-remote "$2" | wc -l | tr -d ' ')" >> ${record}`, `echo "askpass: \${GIT_ASKPASS:-none}" >> ${record}`, `while read -r line; do echo "line: $line" >> ${record}; done`].join('\n');

  it.each([undefined, '.husky'])('runs once, as its own step before anything is sent, with the lines git gives it (hooks path %s)', async (hooksPath) => {
    const { world, head, record, write } = hookWorld(hooksPath);
    write(recording(record));
    const runner = countingRunner();
    const parts = partsOf(operationTool('GitPush', { runArgv: runner.run }), PUSH, contextFor(world.work, world.env));
    const result = await parts.execute(await parts.prepare());
    expect(result.status).toBe('completed');
    expect(shaOfRemote(world, world.bare, 'main')).toBe(head);
    expect(fs.readFileSync(record, 'utf8').trim().split('\n')).toEqual([`args: origin file://${world.bare}`, 'remote refs: 0', 'askpass: none', `line: refs/heads/main ${head} refs/heads/main ${'0'.repeat(40)}`]);
    const hookCall = runner.calls.findIndex((argv) => argv[0]?.endsWith('pre-push') === true);
    const pushCall = runner.calls.findIndex((argv) => argv.includes('push'));
    expect(hookCall).toBeGreaterThanOrEqual(0);
    expect(hookCall).toBeLessThan(pushCall);
    expect(effective(world, runner.environments[pushCall] ?? {}, 'core.hooksPath')).toBe('/dev/null');
  });

  it('runs the hook through the shell on win32, with the hook file as the first operand after the shell', async () => {
    const { world, write } = hookWorld();
    write(recording(path.join(world.base, 'hook-ran')));
    const real = countingRunner();
    const hookArgvs: string[][] = [];
    const run: ArgvRunner = async (argv, options) => {
      if (argv[0] !== 'fake-sh') return real.run(argv, options);
      hookArgvs.push([...argv]);
      return { exitCode: 0, stdout: '', stderr: '' };
    };
    const parts = partsOf(operationTool('GitPush', { runArgv: run, platform: 'win32', shell: async () => 'fake-sh' }), PUSH, contextFor(world.work, world.env));
    await parts.execute(await parts.prepare());
    expect(hookArgvs).toHaveLength(1);
    expect(hookArgvs[0]?.slice(0, 3)).toEqual(['fake-sh', '-c', '"$0" "$@"']);
    expect(hookArgvs[0]?.[3]).toMatch(/pre-push$/);
  });

  it('gives the hook the value of the remote branch when the branch exists, and the delete line for a delete', async () => {
    const { world, head, record, write } = hookWorld();
    world.git(world.work, 'push', '-q', 'origin', 'main', 'main:refs/heads/topic');
    world.write('a.txt', 'two\n');
    const second = world.commitAll('second');
    write(recording(record));
    const push = partsOf(operationTool('GitPush', { runArgv: countingRunner().run }), PUSH, contextFor(world.work, world.env));
    expect((await push.execute(await push.prepare())).status).toBe('completed');
    const remove = partsOf(operationTool('GitPush', { runArgv: countingRunner().run }), { remote: 'origin', branch: 'topic', delete: true }, contextFor(world.work, world.env, 'd'.repeat(64)));
    expect((await remove.execute(await remove.prepare())).status).toBe('completed');
    const lines = fs.readFileSync(record, 'utf8').split('\n').filter((line) => line.startsWith('line: '));
    expect(lines).toEqual([`line: refs/heads/main ${second} refs/heads/main ${head}`, `line: (delete) ${'0'.repeat(40)} refs/heads/topic ${head}`]);
  });

  it('stops the push when the hook fails, shows what the hook printed, and sends nothing', async () => {
    const { world, write } = hookWorld();
    write('echo "blocked by the policy of this repository"\necho "second reason" >&2\nexit 1');
    const runner = countingRunner();
    const parts = partsOf(operationTool('GitPush', { runArgv: runner.run }), PUSH, contextFor(world.work, world.env));
    const result = await parts.execute(await parts.prepare());
    expect(result.status).toBe('failed');
    expect(result.output).toContain('pre-push');
    expect(result.output).toContain('blocked by the policy of this repository');
    expect(result.output).toContain('second reason');
    expect(runner.calls.some((argv) => argv.includes('push'))).toBe(false);
    expect(world.git(world.base, 'ls-remote', world.bare)).toBe('');
  });

  it('is not run when it is not executable, as git does, and the push goes on', async () => {
    const { world, head, record, write } = hookWorld();
    write(recording(record), 0o644);
    const parts = partsOf(operationTool('GitPush', { runArgv: countingRunner().run }), PUSH, contextFor(world.work, world.env));
    expect((await parts.execute(await parts.prepare())).status).toBe('completed');
    expect(fs.existsSync(record)).toBe(false);
    expect(shaOfRemote(world, world.bare, 'main')).toBe(head);
  });

  it('is not run again by the reconcile of an interrupted push', async () => {
    const { world, record, write } = hookWorld();
    write(recording(record));
    const runner = countingRunner();
    const parts = partsOf(operationTool('GitPush', { runArgv: runner.run }), PUSH, contextFor(world.work, world.env));
    const prepared = await parts.prepare();
    expect((await parts.reconcile(prepared, Date.now())).outcome).toBe('not_applied');
    expect(fs.existsSync(record)).toBe(false);
  });
});
