import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { REDACTED_MARKER } from '@momonga/foundation';
import { createUnsandboxed } from '@momonga/sandbox';
import type { Sandbox, SandboxCommand, SandboxPolicy } from '@momonga/sandbox';
import { REAL_PROCESS_TEST_TIMEOUT_MS, unconfiguredNetworkOf, testProcessInspector } from '@momonga/testkit';
import { createOperationTools, createSandboxedArgvRunner, networkScopeOfDestinations, nodeShellHost } from '@momonga/tools';
import type { CallOutcome, NeedsApprovalOutcome, ResultOutcome } from '@momonga/tools';
import { call, makeHarness, toolSetOf } from '../harness.ts';
import { HAS_REAL_SANDBOX, createHostSandbox, makeLayout, policyFor, ruleFor, sessionTmpDirOf } from '../helpers.ts';
import type { Layout } from '../helpers.ts';
import { ENTRY_AS_SCRIPT, NO_FORGE, contextFor, makeGitWorld, onCleanup, recordOf } from './support.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

type Spawn = { argv: readonly string[]; policy: SandboxPolicy };

const recordingSandbox = (inner: Sandbox, spawns: Spawn[]): Sandbox => ({
  kind: inner.kind,
  spawn: (command: SandboxCommand, policy, signal) => {
    spawns.push({ argv: command.argv, policy });
    return inner.spawn(command, policy, signal);
  },
});

const GATE_READS: readonly string[] = ['rev-parse', 'remote', 'config'];

const onlyGateReads = (spawns: readonly Spawn[]): boolean => spawns.every((spawn) => spawn.argv[0] === 'git' && GATE_READS.includes(spawn.argv[1] ?? ''));

const setup = async (options: { realSandbox: boolean; origin?: string }) => {
  const world = makeGitWorld();
  if (options.origin !== undefined) world.git(world.work, 'remote', 'set-url', 'origin', options.origin);
  world.write('a.txt', 'one\n');
  world.commitAll('base');
  const layout: Layout = { ...makeLayout(), root: world.base, home: world.home, project: world.work, outside: path.join(world.base, 'outside') };
  const tmpDir = sessionTmpDirOf(layout);
  const harness = makeHarness();
  const spawns: Spawn[] = [];
  let hostSandbox: Sandbox = createUnsandboxed();
  if (options.realSandbox) {
    const sandboxTmp = path.join(world.base, 'sandbox-tmp');
    fs.mkdirSync(sandboxTmp);
    hostSandbox = createHostSandbox({ tmpRoot: sandboxTmp, killGraceMs: 300 });
  }
  const sandbox = recordingSandbox(hostSandbox, spawns);
  const policyForReconcile = () => policyFor({ layout, tmpDir });
  const markerDir = path.join(world.base, 'markers');
  fs.mkdirSync(markerDir);
  const tools = createOperationTools({
    runArgv: createSandboxedArgvRunner({ inspector: testProcessInspector(), reconcileSandbox: async () => ({ sandbox, sandboxPolicy: await policyForReconcile(), release: () => undefined }), shellHost: nodeShellHost(), outboundNetwork: unconfiguredNetworkOf, markerDir, credentialRoot: world.base }),
    forge: NO_FORGE,
    settings: { protectedRefs: ['release/*'] },
  });
  const toolSet = await toolSetOf(...tools);
  const rule = ruleFor(layout);
  const run = async (name: string, args: unknown, extra: { rules?: Array<ReturnType<typeof rule>>; mode?: 'manual' | 'bypassPermissions' } = {}): Promise<CallOutcome | undefined> => {
    const rules = extra.rules ?? [];
    const sandboxPolicy = await policyFor({ layout, tmpDir, rules });
    const [outcome] = await harness.executor.runBatch(
      await harness.input(toolSet, [call('c1', name, args)], {
        env: world.env,
        sandbox,
        sandboxPolicy: await sandboxPolicy,
        tmpDir,
        roots: [world.work],
        home: world.home,
        session: { cwd: world.work, workingDirectory: world.work, readLedger: new Map() },
        ...(extra.mode === undefined ? {} : { mode: extra.mode }),
        rules,
      }),
    );
    return outcome;
  };
  return { world, layout, spawns, run, rule, harness };
};

const resultOf = (outcome: CallOutcome | undefined): ResultOutcome['result'] => {
  expect(outcome?.kind).toBe('result');
  return (outcome as ResultOutcome).result;
};

const stage = (world: ReturnType<typeof makeGitWorld>): void => {
  world.write('a.txt', 'two\n');
  world.git(world.work, 'add', 'a.txt');
};

describe.skipIf(!HAS_REAL_SANDBOX)('operations through the executor, the policy and the real sandbox', () => {
  it('runs the probes and the commit of GitCommit as sandboxed children with the batch policy and no network', async () => {
    const { world, spawns, run, rule } = await setup({ realSandbox: true });
    stage(world);
    const before = world.git(world.work, 'rev-parse', 'HEAD');
    const result = resultOf(await run('GitCommit', { message: 'Add two' }, { rules: [rule('allow', 'GitCommit')] }));
    expect(result.status).toBe('completed');
    expect(world.git(world.work, 'rev-parse', 'HEAD^')).toBe(before);
    expect(spawns.length).toBeGreaterThan(0);
    expect(spawns.every((spawn) => spawn.argv[0] === 'git')).toBe(true);
    expect(spawns.every((spawn) => spawn.policy.network === 'deny')).toBe(true);
    expect(spawns.some((spawn) => spawn.argv.includes('commit'))).toBe(true);
    expect(result.output).toContain(world.git(world.work, 'rev-parse', 'HEAD'));
  });

  it('refuses GitPush to a remote reached over ssh, with the reason, and spawns no push and no ls-remote', async () => {
    const { world, spawns, run, rule } = await setup({ realSandbox: true, origin: 'git@forge.example:acme/widgets.git' });
    const result = resultOf(await run('GitPush', { remote: 'origin', branch: 'main' }, { rules: [rule('allow', 'GitPush')] }));
    expect(result.status).toBe('failed');
    expect(result.output).toContain('is not reached over HTTP or HTTPS');
    expect(spawns.some((spawn) => spawn.argv.includes('push') || spawn.argv.includes('ls-remote'))).toBe(false);
    expect(world.git(world.work, 'ls-remote', world.bare)).toBe('');
  });

  it('pushes to a local bare remote inside the workspace sandbox, because that needs no network', async () => {
    const { world, run, rule, spawns } = await setup({ realSandbox: true });
    const bare = path.join(world.work, 'remote.git');
    world.git(world.base, 'init', '--bare', '--initial-branch=main', bare);
    world.git(world.work, 'remote', 'set-url', 'origin', `file://${bare}`);
    const result = resultOf(await run('GitPush', { remote: 'origin', branch: 'main' }, { rules: [rule('allow', 'GitPush')] }));
    expect(result.status).toBe('completed');
    expect(world.git(world.base, 'ls-remote', bare, 'refs/heads/main').split(/\s+/)[0]).toBe(world.git(world.work, 'rev-parse', 'HEAD'));
    expect(spawns.every((spawn) => spawn.policy.network === 'deny')).toBe(true);
  });
});

describe.skipIf(!HAS_REAL_SANDBOX)('the pre-push hook of a repository through the executor and the real sandbox', () => {
  it('runs as its own sandboxed child without the network before the push, and the push runs with the hooks of the repository set aside', async () => {
    const { world, spawns, run, rule } = await setup({ realSandbox: true });
    const bare = path.join(world.work, 'remote.git');
    world.git(world.base, 'init', '--bare', '--initial-branch=main', bare);
    world.git(world.work, 'remote', 'set-url', 'origin', `file://${bare}`);
    const ran = path.join(world.work, 'hook-ran');
    fs.writeFileSync(path.join(world.work, '.git', 'hooks', 'pre-push'), `#!/bin/sh\ncat >> ${ran}\n`, { mode: 0o755 });
    const head = world.git(world.work, 'rev-parse', 'HEAD');
    const result = resultOf(await run('GitPush', { remote: 'origin', branch: 'main' }, { rules: [rule('allow', 'GitPush')] }));
    expect(result.status).toBe('completed');
    expect(fs.readFileSync(ran, 'utf8')).toBe(`refs/heads/main ${head} refs/heads/main ${'0'.repeat(40)}\n`);
    const hook = spawns.findIndex((spawn) => spawn.argv[0]?.endsWith('pre-push') === true);
    const push = spawns.findIndex((spawn) => spawn.argv.includes('push'));
    expect(hook).toBeGreaterThanOrEqual(0);
    expect(hook).toBeLessThan(push);
    expect(spawns[hook]?.policy.network).toBe('deny');
    expect(world.git(world.base, 'ls-remote', bare, 'refs/heads/main').split(/\s+/)[0]).toBe(head);
  });
});

describe.skipIf(!HAS_REAL_SANDBOX)('the reconcile of an operation, which has no sandbox in its context', () => {
  it('runs its probes through the sandbox and the reconcile policy of the runner, and reports a landed commit as already applied', async () => {
    const world = makeGitWorld();
    world.write('a.txt', 'one\n');
    world.commitAll('base');
    world.write('a.txt', 'two\n');
    world.git(world.work, 'add', 'a.txt');
    const layout: Layout = { ...makeLayout(), root: world.base, home: world.home, project: world.work, outside: path.join(world.base, 'outside') };
    const tmpDir = sessionTmpDirOf(layout);
    const sandboxTmp = path.join(world.base, 'sandbox-tmp');
    fs.mkdirSync(sandboxTmp);
    const spawns: Spawn[] = [];
    const reconcilePolicy = await policyFor({ layout, tmpDir });
    const sandbox = recordingSandbox(createHostSandbox({ tmpRoot: sandboxTmp, killGraceMs: 300 }), spawns);
    const markerDir = path.join(world.base, 'markers');
    fs.mkdirSync(markerDir);
    const tools = createOperationTools({
      runArgv: createSandboxedArgvRunner({ inspector: testProcessInspector(), reconcileSandbox: async () => ({ sandbox, sandboxPolicy: reconcilePolicy, release: () => undefined }), shellHost: nodeShellHost(), outboundNetwork: unconfiguredNetworkOf, markerDir, credentialRoot: world.base }),
      forge: NO_FORGE,
      settings: {},
    });
    const tool = tools.find((candidate) => candidate.name === 'GitCommit');
    if (tool === undefined || tool.prepare === undefined || tool.reconcile === undefined) throw new Error('GitCommit has no prepare or reconcile');
    const ctx = contextFor(world.work, world.env);
    const input = { message: 'Add two' };
    const prepared = await tool.prepare(input, ctx);
    world.git(world.work, 'commit', '-q', '--cleanup=verbatim', '-m', 'Add two');
    spawns.length = 0;
    const reconciled = await tool.reconcile(input, recordOf('GitCommit', prepared, Date.now()), ctx);
    expect(reconciled.outcome).toBe('already_applied');
    expect(spawns.length).toBeGreaterThan(0);
    expect(spawns.every((spawn) => spawn.policy === reconcilePolicy && spawn.policy.network === 'deny')).toBe(true);
  });
});

describe('a process started without the executable that answers the prompt of git', () => {
  it('refuses a call that carries a credential before anything runs, and says why', async () => {
    const world = makeGitWorld();
    const spawns: Spawn[] = [];
    const sandbox = recordingSandbox(createUnsandboxed(), spawns);
    const layout: Layout = { ...makeLayout(), root: world.base, home: world.home, project: world.work, outside: path.join(world.base, 'outside') };
    const runArgv = createSandboxedArgvRunner({
      inspector: testProcessInspector(),
      reconcileSandbox: async () => ({ sandbox, sandboxPolicy: await policyFor({ layout, tmpDir: sessionTmpDirOf(layout) }), release: () => undefined }),
      shellHost: nodeShellHost(),
      outboundNetwork: unconfiguredNetworkOf,
      markerDir: world.base,
      credentialRoot: world.base,
    });
    const ctx = contextFor(world.work, world.env);
    const credentials = [{ origin: 'https://forge.example', username: 'x-access-token', password: 'fake-git-credential-for-tests' }];
    await expect(runArgv(['git', 'version'], { cwd: world.work, env: world.env, signal: ctx.signal, network: 'none', context: ctx, effect: false, credentials })).rejects.toThrow(
      'git was not run: this process was started without the executable that answers the credential prompt of git',
    );
    expect(spawns).toEqual([]);
  });
});

describe.skipIf(!HAS_REAL_SANDBOX)('the credential of a git child inside the real sandbox', () => {
  const CREDENTIAL = 'fake-git-credential-for-tests';

  it('reaches the child through its askpass program only: the sandbox lets the child ask, and no argument, environment value or output carries it', async () => {
    const world = makeGitWorld();
    const layout: Layout = { ...makeLayout(), root: world.base, home: world.home, project: world.work, outside: path.join(world.base, 'outside') };
    const tmpDir = sessionTmpDirOf(layout);
    const sandboxTmp = path.join(world.base, 'sandbox-tmp');
    fs.mkdirSync(sandboxTmp);
    const spawns: Array<Spawn & { env: Readonly<Record<string, string>> }> = [];
    const host = createHostSandbox({ tmpRoot: sandboxTmp, killGraceMs: 300 });
    const sandbox: Sandbox = {
      kind: host.kind,
      spawn: (command: SandboxCommand, policy, signal) => {
        spawns.push({ argv: command.argv, policy, env: command.env });
        return host.spawn(command, policy, signal);
      },
    };
    const markerDir = path.join(world.base, 'markers');
    fs.mkdirSync(markerDir);
    const credentialRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'mm-cred-')));
    onCleanup(() => fs.rmSync(credentialRoot, { recursive: true, force: true }));
    const runArgv = createSandboxedArgvRunner({ inspector: testProcessInspector(), reconcileSandbox: async () => ({ sandbox, sandboxPolicy: await policyFor({ layout, tmpDir }), release: () => undefined }), shellHost: nodeShellHost(), outboundNetwork: unconfiguredNetworkOf, markerDir, credentialRoot, credentialHelper: ENTRY_AS_SCRIPT });
    const ctx = contextFor(world.work, world.env);
    const ask = `"$GIT_ASKPASS" "Password for 'https://x-access-token@forge.example': "`;
    const options = { cwd: world.work, env: world.env, signal: ctx.signal, network: 'none' as const, context: ctx, effect: false };

    const answered = await runArgv(['/bin/sh', '-c', ask], { ...options, credentials: [{ origin: 'https://forge.example', username: 'x-access-token', password: CREDENTIAL }] });
    expect(answered).toMatchObject({ exitCode: 0, stdout: `${REDACTED_MARKER}\n` });
    const [spawn] = spawns;
    expect(spawn?.policy.unixSocketAllow?.some((entry) => entry.startsWith(credentialRoot))).toBe(true);
    expect(spawn?.argv.some((argument) => argument.includes(CREDENTIAL))).toBe(false);
    expect(Object.values(spawn?.env ?? {}).some((value) => value.includes(CREDENTIAL))).toBe(false);
    expect(fs.readdirSync(credentialRoot)).toEqual([]);

    const unanswered = await runArgv(['/bin/sh', '-c', `[ -z "\${GIT_ASKPASS:-}" ] && echo none`], options);
    expect(unanswered).toMatchObject({ exitCode: 0, stdout: 'none\n' });
  });
});

describe('operations through the executor and the policy, which spawn only the reads the permission is decided on', () => {
  const FORGE_ORIGIN = 'https://forge.example/acme/widgets.git';
  const SHA = 'a'.repeat(40);

  it('asks a person for GitPush when no rule allows it, and runs nothing but those reads', async () => {
    const { run, spawns } = await setup({ realSandbox: false });
    const outcome = await run('GitPush', { remote: 'origin', branch: 'main' });
    expect(outcome?.kind).toBe('needs_approval');
    expect(onlyGateReads(spawns)).toBe(true);
  });

  it('gives a force push and a delete their own titles and digests, and shows the rendered command with its destination', async () => {
    const { run } = await setup({ realSandbox: false });
    const asked = async (input: Record<string, unknown>): Promise<NeedsApprovalOutcome> => {
      const outcome = await run('GitPush', input);
      if (outcome?.kind !== 'needs_approval') throw new Error(`GitPush did not ask: ${JSON.stringify(outcome)}`);
      return outcome;
    };
    const plain = await asked({ remote: 'origin', branch: 'main' });
    const forced = await asked({ remote: 'origin', branch: 'main', force: true });
    const deleted = await asked({ remote: 'origin', branch: 'main', delete: true });
    expect(plain.title).toBe('Push main to origin');
    expect(forced.title).toBe('Force push main to origin');
    expect(deleted.title).toBe('Delete the remote branch main on origin');
    expect(new Set([plain.subjectDigest, forced.subjectDigest, deleted.subjectDigest]).size).toBe(3);
    expect(plain.shown.effect).toContain('git push origin refs/heads/main:refs/heads/main');
    expect(forced.shown.effect).toContain('--force-with-lease=refs/heads/main:');
    expect(deleted.shown.effect).toContain('git push origin :refs/heads/main');
    expect(plain.shown.effect).toMatch(/\nto \S+/);
  });

  it('asks a person for a push to a protected ref even under an allow rule and bypassPermissions', async () => {
    const { run, rule, spawns } = await setup({ realSandbox: false });
    const outcome = await run('GitPush', { remote: 'origin', branch: 'release/1' }, { rules: [rule('allow', 'GitPush')], mode: 'bypassPermissions' });
    expect(outcome?.kind).toBe('needs_approval');
    expect(onlyGateReads(spawns)).toBe(true);
  });

  it('asks a person for PullRequestMerge even under an allow rule and bypassPermissions', async () => {
    const { run, rule, spawns } = await setup({ realSandbox: false, origin: FORGE_ORIGIN });
    const outcome = await run('PullRequestMerge', { number: 7, headSha: SHA }, { rules: [rule('allow', 'PullRequestMerge(*)')], mode: 'bypassPermissions' });
    expect(outcome?.kind).toBe('needs_approval');
    expect(onlyGateReads(spawns)).toBe(true);
  });

  it('denies PullRequestMerge under an explicit deny rule', async () => {
    const { run, rule } = await setup({ realSandbox: false, origin: FORGE_ORIGIN });
    const result = resultOf(await run('PullRequestMerge', { number: 7, headSha: SHA }, { rules: [rule('deny', 'PullRequestMerge(*)')] }));
    expect(result.status).toBe('failed');
  });
});

describe('the network a child of an operation gets', () => {
  it('is none for local destinations and the named hosts for HTTP and HTTPS destinations', () => {
    expect(networkScopeOfDestinations(['file:///srv/a.git', '/srv/b.git'], 'git push')).toEqual({ kind: 'none' });
    expect(networkScopeOfDestinations(['https://forge.example/acme/widgets.git', 'https://forge.example/acme/other.git', 'http://mirror.example:8080/x.git'], 'git push')).toEqual({
      kind: 'hosts',
      hosts: ['forge.example', 'mirror.example:8080'],
    });
  });

  it.each(['git@forge.example:acme/widgets.git', 'ssh://git@forge.example/acme/widgets.git', 'git://forge.example/acme/widgets.git', 'ext::sh -c x'])('refuses %s, which the sandbox network does not carry', async (destination) => {
    await expect((async () => networkScopeOfDestinations([destination], 'git push'))()).rejects.toThrow('is not reached over HTTP or HTTPS');
  });
});
