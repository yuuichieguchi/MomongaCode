import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_BWRAP_PATH, createBubblewrapSandbox, createPlaceholderJournal, createSeatbeltSandbox, heldMountPoints } from '@momonga/sandbox';
import type { Sandbox } from '@momonga/sandbox';
import { createTempDir, REAL_PROCESS_TEST_TIMEOUT_MS, hostBuiltSocketGuard, startFakeGitHttp, testKernelLock, testProcessInspector, unconfiguredNetworkOf } from '@momonga/testkit';
import { createSandboxedArgvRunner, nodeShellHost } from '@momonga/tools';
import { makeLayout, policyFor, sessionTmpDirOf } from '../helpers.ts';
import type { Layout } from '../helpers.ts';
import { ENTRY_AS_SCRIPT, contextFor, makeGitWorld, onCleanup } from './support.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const RELAY_MAIN = fileURLToPath(new URL('../../../sandbox/test/relay-main.ts', import.meta.url));
const HAS_BWRAP = process.platform === 'linux' && fs.existsSync(DEFAULT_BWRAP_PATH);
const HOSTS_HOST = process.platform === 'darwin' || HAS_BWRAP;
const USERNAME = 'x-access-token';
const PASSWORD = 'fake-git-credential-for-tests';

const scopedSandbox = (tmpRoot: string): Sandbox =>
  process.platform === 'darwin'
    ? createSeatbeltSandbox({ lock: testKernelLock(), tmpRoot, killGraceMs: 300 })
    : createBubblewrapSandbox({ lock: testKernelLock(), tmpRoot, killGraceMs: 300, journal: createPlaceholderJournal(`${tmpRoot}-journal`), holders: heldMountPoints, socketGuard: hostBuiltSocketGuard(), relay: () => [process.execPath, RELAY_MAIN] });

const stage = async () => {
  const world = makeGitWorld();
  world.write('a.txt', 'one\n');
  world.commitAll('first');
  const server = await startFakeGitHttp({ projectRoot: world.base, username: USERNAME, password: PASSWORD });
  onCleanup(() => server.close());
  const layout: Layout = { ...makeLayout(), root: world.base, home: world.home, project: world.work, outside: path.join(world.base, 'outside') };
  const sandboxTmp = path.join(world.base, 'sandbox-tmp');
  fs.mkdirSync(sandboxTmp);
  const sandbox = scopedSandbox(sandboxTmp);
  const markerDir = path.join(world.base, 'markers');
  fs.mkdirSync(markerDir);
  const credentialRoot = createTempDir();
  onCleanup(() => fs.rmSync(credentialRoot, { recursive: true, force: true }));
  const runArgv = createSandboxedArgvRunner({
    inspector: testProcessInspector(),
    reconcileSandbox: async () => ({ sandbox, sandboxPolicy: await policyFor({ layout, tmpDir: sessionTmpDirOf(layout) }), release: () => undefined }),
    shellHost: nodeShellHost(),
    outboundNetwork: unconfiguredNetworkOf,
    markerDir,
    credentialRoot,
    drainIdleMs: () => 1000,
    credentialHelper: ENTRY_AS_SCRIPT,
  });
  const remote = `${server.origin}/remote.git`;
  const push = (destinations: readonly string[]) => {
    const ctx = contextFor(world.work, world.env);
    return runArgv(['git', 'push', remote, 'HEAD:refs/heads/main'], {
      cwd: world.work,
      env: world.env,
      signal: ctx.signal,
      network: { destinations: [...destinations] },
      context: ctx,
      effect: false,
      credentials: [{ origin: server.origin, username: USERNAME, password: PASSWORD }],
    });
  };
  const pushed = (): string => world.git(world.base, '--git-dir', path.join(world.base, 'remote.git'), 'for-each-ref', '--format=%(refname)');
  return { server, remote, push, pushed };
};

describe.runIf(HOSTS_HOST)('a git push over the hosts scope inside the platform sandbox (on Linux through the network relay)', () => {
  it('reaches the granted remote and pushes the branch', async () => {
    const { server, remote, push, pushed } = await stage();
    const result = await push([remote]);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(server.served()).toBeGreaterThan(0);
    expect(pushed()).toBe('refs/heads/main');
  });

  it('is refused a remote whose host was not granted', async () => {
    const { server, push, pushed } = await stage();
    const result = await push(['http://forge.invalid/remote.git']);
    expect(result.exitCode).not.toBe(0);
    expect(server.served()).toBe(0);
    expect(server.refused()).toBe(0);
    expect(pushed()).toBe('');
  });
});
