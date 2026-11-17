import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { NO_NETWORK, OPEN_NETWORK } from '@momonga/foundation';
import type { NetworkScope } from '@momonga/foundation';
import { createUnsandboxed } from '@momonga/sandbox';
import type { Sandbox, SandboxCommand, SandboxPolicy } from '@momonga/sandbox';
import { REAL_PROCESS_TEST_TIMEOUT_MS, TEST_CHILD_UNPROTECTED, startFakeGitHttp, testProcessInspector, unconfiguredNetworkOf } from '@momonga/testkit';
import { createOperationTools, createSandboxedArgvRunner, nodeShellHost } from '@momonga/tools';
import type { CallOutcome } from '@momonga/tools';
import { callNetworkOf } from '../../src/network-scope.ts';
import { call, makeHarness, toolSetOf } from '../harness.ts';
import { makeLayout, policyFor, sessionTmpDirOf } from '../helpers.ts';
import type { Layout } from '../helpers.ts';
import { NO_FORGE, contextFor, makeGitWorld, onCleanup } from './support.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const HOSTS: NetworkScope = { kind: 'hosts', hosts: ['forge.example'] };

describe('a hosts request of a git operation where the sandbox cannot hold it to its hosts', () => {
  it('is answered as the open form without a host limit when the setting admits open, and refused under deny naming the forms', () => {
    for (const setting of ['ask', 'allow'] as const) {
      expect(callNetworkOf({ requested: HOSTS, granted: HOSTS, sandbox: 'none', unkeptHosts: setting })).toEqual({ kind: 'admitted', scope: OPEN_NETWORK, sandboxNetwork: 'allow', unlimited: true });
    }
    const refused = callNetworkOf({ requested: HOSTS, granted: HOSTS, sandbox: 'none', unkeptHosts: 'deny' });
    expect(refused.kind).toBe('refused');
    expect(refused.kind === 'refused' ? refused.reason : '').toContain('network "open"');
    expect(refused.kind === 'refused' ? refused.reason : '').toContain('sandboxNetwork is deny');
    expect(callNetworkOf({ requested: HOSTS, granted: HOSTS, sandbox: 'none', unkeptHosts: 'refuse' }).kind).toBe('refused');
    expect(callNetworkOf({ requested: HOSTS, granted: HOSTS, sandbox: 'seatbelt', unkeptHosts: 'ask' })).toEqual({ kind: 'admitted', scope: HOSTS, sandboxNetwork: 'deny' });
    expect(callNetworkOf({ requested: NO_NETWORK, granted: NO_NETWORK, sandbox: 'none', unkeptHosts: 'deny' })).toEqual({ kind: 'admitted', scope: NO_NETWORK, sandboxNetwork: 'allow' });
  });
});

type Spawn = { argv: readonly string[]; policy: SandboxPolicy; env: Readonly<Record<string, string>> };

const recording = (spawns: Spawn[]): Sandbox => {
  const inner = createUnsandboxed({ protection: TEST_CHILD_UNPROTECTED, platform: process.platform });
  return { kind: inner.kind, spawn: (command: SandboxCommand, policy, signal) => (spawns.push({ argv: command.argv, policy, env: command.env }), inner.spawn(command, policy, signal)) };
};

const stage = async () => {
  const world = makeGitWorld();
  world.write('a.txt', 'one\n');
  world.commitAll('first');
  const server = await startFakeGitHttp({ projectRoot: world.base, username: 'x-access-token', password: 'fake-git-credential-for-tests' });
  onCleanup(() => server.close());
  const remote = `${server.origin}/remote.git`;
  world.git(world.work, 'remote', 'set-url', 'origin', remote);
  const layout: Layout = { ...makeLayout(), root: world.base, home: world.home, project: world.work, outside: path.join(world.base, 'outside') };
  const spawns: Spawn[] = [];
  const sandbox = recording(spawns);
  const runArgv = createSandboxedArgvRunner({
    inspector: testProcessInspector(),
    reconcileSandbox: async () => ({ sandbox, sandboxPolicy: await policyFor({ layout, tmpDir: sessionTmpDirOf(layout) }), release: () => undefined }),
    shellHost: nodeShellHost(),
    outboundNetwork: unconfiguredNetworkOf,
    markerDir: world.base,
    drainIdleMs: () => 1000,
    credentialRoot: world.base,
  });
  return { world, layout, sandbox, spawns, remote, runArgv };
};

describe('a git process with a network destination under the sandbox none', () => {
  it('is not started under the setting deny, and says which forms the sandbox accepts', async () => {
    const { world, spawns, remote, runArgv } = await stage();
    const ctx = { ...contextFor(world.work, world.env), sandboxNetwork: 'deny' as const };
    await expect(runArgv(['git', 'ls-remote', remote], { cwd: world.work, env: world.env, signal: ctx.signal, network: { destinations: [remote] }, context: ctx, effect: false })).rejects.toThrow('network "open"');
    expect(spawns).toEqual([]);
  });

  it('runs with the network of the host and no proxy under ask and allow', async () => {
    for (const sandboxNetwork of ['ask', 'allow'] as const) {
      const { world, spawns, remote, runArgv } = await stage();
      const ctx = { ...contextFor(world.work, world.env), sandboxNetwork };
      await runArgv(['git', 'ls-remote', remote], { cwd: world.work, env: world.env, signal: ctx.signal, network: { destinations: [remote] }, context: ctx, effect: false });
      expect(spawns.map((spawn) => [spawn.policy.network, spawn.env['HTTPS_PROXY']])).toEqual([['allow', undefined]]);
    }
  });
});

describe('the permission of GitPush to a remote reached over the network under the sandbox none', () => {
  const push = async (sandboxNetwork: 'ask' | 'deny'): Promise<CallOutcome | undefined> => {
    const { world, layout, sandbox } = await stage();
    const tools = createOperationTools({
      runArgv: createSandboxedArgvRunner({ inspector: testProcessInspector(), reconcileSandbox: async () => ({ sandbox, sandboxPolicy: await policyFor({ layout, tmpDir: sessionTmpDirOf(layout) }), release: () => undefined }), shellHost: nodeShellHost(), outboundNetwork: unconfiguredNetworkOf, markerDir: world.base, drainIdleMs: () => 1000, credentialRoot: world.base }),
      forge: NO_FORGE,
      settings: {},
      platform: process.platform, shell: async () => '/bin/sh',
    });
    const harness = makeHarness();
    const tmpDir = sessionTmpDirOf(layout);
    const [outcome] = await harness.executor.runBatch(
      await harness.input(await toolSetOf(...tools), [call('c1', 'GitPush', { remote: 'origin', branch: 'main' })], {
        env: world.env,
        sandbox,
        sandboxPolicy: await policyFor({ layout, tmpDir }),
        tmpDir,
        roots: [world.work],
        home: world.home,
        session: { cwd: world.work, workingDirectory: world.work, readLedger: new Map() },
        mode: 'manual',
        rules: [],
        sandboxNetwork,
      }),
    );
    return outcome;
  };

  it('asks the person and says the operation runs with unrestricted network access under ask', async () => {
    const outcome = await push('ask');
    expect(outcome?.kind).toBe('needs_approval');
    expect(outcome?.kind === 'needs_approval' ? outcome.decision.reason : '').toContain('runs with unrestricted network access');
  });

  it('is refused under deny, naming the forms the sandbox accepts', async () => {
    const outcome = await push('deny');
    expect(outcome?.kind).toBe('result');
    const result = outcome?.kind === 'result' ? outcome.result : undefined;
    expect(result?.status).toBe('failed');
    expect(`${result?.denial?.reason ?? ''}${result?.output ?? ''}`).toContain('network "open"');
  });
});
