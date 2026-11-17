import { execFileSync } from '@momonga/testkit/child-process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { fakeSecretProgramsBin, startFakeForge, startFakeGitHttps, writeFakeSecretItem } from '@momonga/testkit';
import type { FakeForge, FakeGitHttps, FakeScriptEntry } from '@momonga/testkit';
import { skipCase, titleOf } from './support/cases.ts';
import { createE2eHome, registerE2eCleanup } from './support/home.ts';
import type { E2eHome } from './support/home.ts';
import { createRuntimeClient, framesOfType } from './support/runtime-client.ts';
import type { RuntimeClient } from './support/runtime-client.ts';
import { sandboxOrSkip } from './support/sandbox.ts';
import { baseSettings, sandboxChoiceOf, startStack, withUpstreamConnection } from './support/stack.ts';
import { childOf } from './support/supervisor-client.ts';
import { textReply, toolCallReply } from './support/upstream.ts';
import { E2E_MARGIN_MS, E2E_RECOVERY_BOUND_MS, E2E_RESTART_POLICY, E2E_RUN_COMPLETED_BOUND_MS, E2E_TEST_TIMEOUT_MS, until } from './support/wait.ts';

const FORGE_SECRET = `forge-delegated-${process.pid}`;
const FORGE_CREDENTIAL = 'e2e-forge-credential-5b8e2c61';
const BRANCH = 'feature/delegated';
const OPERATIONS = ['GitBranch', 'GitStage', 'GitCommit', 'GitPush', 'PullRequestCreate', 'PullRequestStatus'];
const GIT_ENV_OF = (home: E2eHome): Record<string, string> => ({ PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: home.home, LANG: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' });

const gitAt = (home: E2eHome, cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV_OF(home) }).trim();

const initRepository = (home: E2eHome, at: string, fetchUrl: string, bare: string): void => {
  gitAt(home, at, 'init', '-q', '--initial-branch=main');
  gitAt(home, at, 'init', '-q', '--bare', '--initial-branch=main', bare);
  fs.appendFileSync(path.join(at, '.git', 'info', 'exclude'), '/*.git/\n/hooks/\n/hook-runs.log\n/pre-push-ran\n');
  gitAt(home, at, 'config', 'user.name', 'Momonga E2E');
  gitAt(home, at, 'config', 'user.email', 'e2e@example.invalid');
  gitAt(home, at, 'remote', 'add', 'origin', fetchUrl);
  gitAt(home, at, 'remote', 'set-url', '--push', 'origin', bare);
  fs.writeFileSync(path.join(at, 'widgets.txt'), 'one\n');
  gitAt(home, at, 'add', 'widgets.txt');
  gitAt(home, at, 'commit', '-q', '-m', 'base');
  gitAt(home, at, 'push', '-q', 'origin', 'main');
};

const trustProject = async (runtime: RuntimeClient, home: E2eHome): Promise<void> => {
  expect((await runtime.json('PUT', '/v1/trust', { path: home.project, decision: 'trusted' })).status).toBe(200);
};

const forgeSettings = (forge: FakeForge) => ({ forges: [{ id: 'local', descriptor: 'github', hosts: [forge.host], apiBaseUrl: forge.origin, credential: { secret: FORGE_SECRET } }] });

const startForge = async (): Promise<FakeForge> => {
  const forge = await startFakeForge('hub', FORGE_CREDENTIAL);
  registerE2eCleanup(() => forge.close());
  writeFakeSecretItem(fakeSecretProgramsBin(), FORGE_SECRET, FORGE_CREDENTIAL);
  return forge;
};

const mandateOf = (allow: readonly string[]) => ({ scope: { allow: [...allow] }, completion: { conditions: [{ command: 'true' }] } });

const localModels = (home: E2eHome) => withUpstreamConnection(baseSettings(home, sandboxChoiceOf({ home }).kind), (connection) => ({ ...connection, billing: 'local' }))['models'];

const runToEnd = async (runtime: RuntimeClient, input: string, allow: readonly string[]) => {
  const { session } = await runtime.createSession({ permissionMode: 'manual' });
  const { run } = await runtime.createRun(session.id, input, { mandate: mandateOf(allow) });
  await until(async () => ['COMPLETED', 'FAILED', 'STOPPED', 'CANCELLED'].includes((await runtime.getRun(run.id)).run.status), { deadlineMs: E2E_RUN_COMPLETED_BOUND_MS, description: `run ${run.id} ended` });
  const stream = runtime.events(run.id);
  const frames = await stream.toEnd(E2E_MARGIN_MS);
  await stream.close();
  return { run: (await runtime.getRun(run.id)).run, frames };
};

const operationOf = (data: Readonly<Record<string, unknown>>): unknown => {
  const effect = data['effect'];
  return typeof effect === 'object' && effect !== null ? (effect as Record<string, unknown>)['operation'] : undefined;
};

const outputsOf = (frames: Awaited<ReturnType<typeof runToEnd>>['frames'], operation: string): string[] =>
  framesOfType(frames, 'tool.completed')
    .filter((frame) => operationOf(frame.data) === operation)
    .map((frame) => String(frame.data['output']));

const allOutputsOf = (frames: Awaited<ReturnType<typeof runToEnd>>['frames']): string =>
  framesOfType(frames, 'tool.completed')
    .map((frame) => String(frame.data['output']))
    .join('\n');

const GIT_USERNAME = 'x-access-token';

const startGitHttps = async (home: E2eHome): Promise<FakeGitHttps> => {
  const server = await startFakeGitHttps({ root: home.root, repository: 'acme/widgets.git', username: GIT_USERNAME, credential: FORGE_CREDENTIAL });
  registerE2eCleanup(() => server.close());
  writeFakeSecretItem(fakeSecretProgramsBin(), FORGE_SECRET, FORGE_CREDENTIAL);
  return server;
};

const initHttpsRepository = (home: E2eHome, server: FakeGitHttps): void => {
  gitAt(home, home.project, 'init', '-q', '--initial-branch=main');
  gitAt(home, home.project, 'config', 'user.name', 'Momonga E2E');
  gitAt(home, home.project, 'config', 'user.email', 'e2e@example.invalid');
  fs.writeFileSync(path.join(home.project, 'widgets.txt'), 'one\n');
  gitAt(home, home.project, 'add', 'widgets.txt');
  gitAt(home, home.project, 'commit', '-q', '-m', 'base');
  gitAt(home, home.project, 'push', '-q', server.repositoryPath, 'main');
  gitAt(home, home.project, 'remote', 'add', 'origin', `${server.origin}/acme/widgets.git`);
};

const httpsForgeSettings = (server: FakeGitHttps) => ({
  forges: [{ id: 'local', descriptor: 'github', hosts: [server.host], apiBaseUrl: server.origin, credential: { secret: FORGE_SECRET } }],
  network: { extraCaFiles: [server.caFile] },
});

describe('gitpr: delegated work through the real runtime, from the production start path', () => {
  it.skipIf(skipCase('gitpr-delegated-https-push'))(titleOf('gitpr-delegated-https-push'), { timeout: E2E_TEST_TIMEOUT_MS }, async (context) => {
    sandboxOrSkip(context);
    const home = await createE2eHome();
    const server = await startGitHttps(home);
    initHttpsRepository(home, server);
    await startStack({ home, settings: { ...httpsForgeSettings(server), models: localModels(home) }, script: [toolCallReply('GitPush', { remote: 'origin', branch: 'main' }, 'call_push'), textReply('done')] });
    const runtime = createRuntimeClient(home);
    try {
      await trustProject(runtime, home);
      fs.appendFileSync(path.join(home.project, 'widgets.txt'), 'two\n');
      gitAt(home, home.project, 'commit', '-q', '-am', 'Add the second widget');
      const { run, frames } = await runToEnd(runtime, 'Push main', ['GitPush']);
      expect(allOutputsOf(frames)).not.toMatch(/certificate|SSL/i);
      expect(outputsOf(frames, 'GitPush').join('\n')).not.toContain('file effects were not observed');
      expect(run.status).toBe('COMPLETED');
      expect(gitAt(home, server.repositoryPath, 'log', '-1', '--format=%s', 'main'), allOutputsOf(frames)).toBe('Add the second widget');
      expect(server.requests.some((request) => request.path.endsWith('/git-receive-pack') && request.authorized)).toBe(true);
      expect(JSON.stringify(frames)).not.toContain(FORGE_CREDENTIAL);
    } finally {
      await runtime.close();
    }
  });

  it.skipIf(skipCase('gitpr-delegated-https-egress'))(titleOf('gitpr-delegated-https-egress'), { timeout: E2E_TEST_TIMEOUT_MS }, async (context) => {
    sandboxOrSkip(context);
    const home = await createE2eHome();
    const server = await startGitHttps(home);
    initHttpsRepository(home, server);
    const undeclared = server.origin.replace('://127.0.0.1:', '://localhost:');
    gitAt(home, home.project, 'remote', 'add', 'undeclared', `${undeclared}/acme/widgets.git`);
    await startStack({
      home,
      settings: { ...httpsForgeSettings(server), models: localModels(home) },
      script: [toolCallReply('GitPush', { remote: 'origin', branch: 'main' }, 'call_push_declared'), toolCallReply('GitPush', { remote: 'undeclared', branch: 'main' }, 'call_push_undeclared'), textReply('done')],
    });
    const runtime = createRuntimeClient(home);
    try {
      await trustProject(runtime, home);
      fs.appendFileSync(path.join(home.project, 'widgets.txt'), 'two\n');
      gitAt(home, home.project, 'commit', '-q', '-am', 'Add the second widget');
      const before = server.requests.length;
      const { frames } = await runToEnd(runtime, 'Push main to both remotes', ['GitPush']);
      const [declared, refused] = outputsOf(frames, 'GitPush');
      expect(declared, allOutputsOf(frames)).not.toMatch(/did not reach its goal/);
      expect(refused).toMatch(/localhost:\d+.*CONNECT tunnel failed, response 403/s);
      expect(server.requests.slice(before).every((request) => request.authorized || request.path.endsWith('/info/refs'))).toBe(true);
      expect(server.requests.slice(before).filter((request) => request.path.endsWith('/git-receive-pack'))).toHaveLength(1);
      expect(JSON.stringify(frames)).not.toContain(FORGE_CREDENTIAL);
    } finally {
      await runtime.close();
    }
  });

  it.skipIf(skipCase('gitpr-delegated-sequence'))(titleOf('gitpr-delegated-sequence'), { timeout: E2E_TEST_TIMEOUT_MS }, async (context) => {
    sandboxOrSkip(context);
    const home = await createE2eHome();
    const project = fs.realpathSync.native(home.project);
    const forge = await startForge();
    const bare = path.join(home.project, 'remote.git');
    initRepository(home, home.project, `${forge.origin}/acme/widgets.git`, bare);
    const headOfBranch = (): string => gitAt(home, home.project, 'rev-parse', BRANCH);
    const pullRequest: FakeScriptEntry = {
      kind: 'deferred',
      reply: () => {
        const headSha = headOfBranch();
        forge.branchSha.set(BRANCH, headSha);
        forge.checks.set(headSha, [{ name: 'unit-tests', status: 'completed', conclusion: 'success' }]);
        return toolCallReply('PullRequestCreate', { head: BRANCH, base: 'main', title: 'Two widgets', body: 'Adds the second widget.', headSha }, 'call_pr');
      },
    };
    const script: FakeScriptEntry[] = [
      toolCallReply('GitBranch', { name: BRANCH, create: true }, 'call_branch'),
      toolCallReply('Write', { file_path: path.join(project, 'widgets.txt'), content: 'one\ntwo\n' }, 'call_write_unread'),
      toolCallReply('Read', { file_path: path.join(project, 'widgets.txt') }, 'call_read'),
      toolCallReply('Write', { file_path: path.join(project, 'widgets.txt'), content: 'one\ntwo\n' }, 'call_write'),
      toolCallReply('GitStage', { paths: ['widgets.txt'] }, 'call_stage'),
      toolCallReply('GitCommit', { message: 'Add the second widget' }, 'call_commit'),
      toolCallReply('GitPush', { remote: 'origin', branch: BRANCH }, 'call_push'),
      pullRequest,
      toolCallReply('PullRequestStatus', { number: 1 }, 'call_status'),
      textReply('Opened pull request #1; its checks pass.'),
    ];
    await startStack({ home, settings: { ...forgeSettings(forge), models: localModels(home) }, script });
    const runtime = createRuntimeClient(home);
    try {
      await trustProject(runtime, home);
      const { run, frames } = await runToEnd(runtime, 'Add the second widget and open a pull request', [`Write(./widgets.txt)`, ...OPERATIONS]);
      expect(run.status).toBe('COMPLETED');
      expect(gitAt(home, bare, 'log', '-1', '--format=%s', BRANCH)).toBe('Add the second widget');
      expect(gitAt(home, bare, 'rev-list', '--count', BRANCH)).toBe('2');
      expect(forge.creates()).toBe(1);
      expect(forge.openPullsFor(BRANCH, 'main')).toHaveLength(1);
      expect(allOutputsOf(frames)).toContain('unit-tests');
      expect(JSON.stringify(frames)).not.toContain(FORGE_CREDENTIAL);
    } finally {
      await runtime.close();
    }
  });

  it.skipIf(skipCase('gitpr-delegated-commit-kill'))(titleOf('gitpr-delegated-commit-kill'), { timeout: E2E_TEST_TIMEOUT_MS }, async (context) => {
    sandboxOrSkip(context);
    const home = await createE2eHome();
    const bare = path.join(home.project, 'remote.git');
    initRepository(home, home.project, bare, bare);
    const base = gitAt(home, home.project, 'rev-parse', 'HEAD');
    const runs = path.join(home.project, 'hook-runs.log');
    fs.writeFileSync(path.join(home.project, '.git', 'hooks', 'pre-commit'), `#!/bin/sh\necho run >> ${runs}\n[ "$(wc -l < ${runs} | tr -d ' ')" -gt 1 ] || sleep 60\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(home.project, 'widgets.txt'), 'one\ntwo\n');
    gitAt(home, home.project, 'add', 'widgets.txt');
    const stack = await startStack({ home, needsBash: true, deps: { restart: E2E_RESTART_POLICY }, settings: { models: localModels(home) }, script: [toolCallReply('GitCommit', { message: 'Add the second widget' }, 'call_commit'), textReply('done')] });
    const runtime = createRuntimeClient(home);
    try {
      await trustProject(runtime, home);
      const { session } = await runtime.createSession({ permissionMode: 'manual' });
      const { run } = await runtime.createRun(session.id, 'Commit the staged change', { mandate: mandateOf(['GitCommit']) });
      await until(() => fs.existsSync(runs), { deadlineMs: E2E_RECOVERY_BOUND_MS, description: 'the commit hook of the first attempt has started' });
      const pid = childOf(await stack.client.health(), 'runtime').pid;
      if (pid === undefined) throw new Error('the runtime has no pid');
      process.kill(pid, 'SIGKILL');
      await until(async () => (await runtime.getRun(run.id)).run.status === 'COMPLETED', { deadlineMs: E2E_RUN_COMPLETED_BOUND_MS, description: `run ${run.id} COMPLETED after recovery` });
      expect(gitAt(home, home.project, 'rev-list', '--count', 'HEAD')).toBe('2');
      expect(gitAt(home, home.project, 'rev-parse', 'HEAD^')).toBe(base);
    } finally {
      await runtime.close();
    }
  });

  it.skipIf(skipCase('gitpr-delegated-remotes'))(titleOf('gitpr-delegated-remotes'), { timeout: E2E_TEST_TIMEOUT_MS }, async (context) => {
    sandboxOrSkip(context);
    const home = await createE2eHome();
    const forge = await startForge();
    const bare = path.join(home.project, 'remote.git');
    initRepository(home, home.project, `git@${forge.host.split(':')[0] ?? forge.host}:acme/widgets.git`, bare);
    gitAt(home, home.project, 'switch', '-q', '-c', BRANCH);
    fs.writeFileSync(path.join(home.project, 'widgets.txt'), 'one\ntwo\n');
    gitAt(home, home.project, 'commit', '-q', '-am', 'Add the second widget');
    gitAt(home, home.project, 'remote', 'add', 'elsewhere', 'git@code.example.invalid:acme/widgets.git');
    await startStack({
      home,
      settings: { ...forgeSettings(forge), models: localModels(home) },
      script: [toolCallReply('GitPush', { remote: 'elsewhere', branch: BRANCH }, 'call_push_elsewhere'), toolCallReply('GitPush', { remote: 'origin', branch: BRANCH }, 'call_push'), textReply('pushed')],
    });
    const runtime = createRuntimeClient(home);
    try {
      await trustProject(runtime, home);
      const { frames } = await runToEnd(runtime, 'Push the branch', ['GitPush']);
      expect(allOutputsOf(frames)).toContain('This remote is not on a declared forge. Declare the forge in settings (forges)');
      expect(outputsOf(frames, 'GitPush')).toHaveLength(1);
      expect(gitAt(home, bare, 'log', '-1', '--format=%s', BRANCH)).toBe('Add the second widget');
    } finally {
      await runtime.close();
    }
  });

  it.skipIf(skipCase('gitpr-delegated-nested'))(titleOf('gitpr-delegated-nested'), { timeout: E2E_TEST_TIMEOUT_MS }, async (context) => {
    sandboxOrSkip(context);
    const home = await createE2eHome();
    const outerBare = path.join(home.root, 'outer.git');
    const innerBare = path.join(home.project, 'inner.git');
    const outer = path.dirname(home.project);
    gitAt(home, outer, 'init', '-q', '--initial-branch=main');
    gitAt(home, outer, 'init', '-q', '--bare', '--initial-branch=main', outerBare);
    gitAt(home, outer, 'remote', 'add', 'origin', outerBare);
    initRepository(home, home.project, innerBare, innerBare);
    gitAt(home, home.project, 'switch', '-q', '-c', BRANCH);
    fs.writeFileSync(path.join(home.project, 'widgets.txt'), 'one\ntwo\n');
    gitAt(home, home.project, 'commit', '-q', '-am', 'Add the second widget');
    await startStack({ home, script: [toolCallReply('GitPush', { remote: 'origin', branch: BRANCH }, 'call_push'), textReply('pushed')] });
    const runtime = createRuntimeClient(home);
    try {
      await trustProject(runtime, home);
      const { session } = await runtime.createSession({ permissionMode: 'manual' });
      const { run } = await runtime.createRun(session.id, 'Push the branch');
      const stream = runtime.events(run.id);
      const requested = await stream.until((frame) => frame.data.type === 'tool.permission.requested', E2E_RUN_COMPLETED_BOUND_MS);
      await stream.close();
      const approvalId = requested.data['approvalId'];
      if (typeof approvalId !== 'string') throw new Error(`tool.permission.requested without an approvalId: ${JSON.stringify(requested.data)}`);
      expect(JSON.stringify(requested.data)).toContain(innerBare);
      expect(JSON.stringify(requested.data)).not.toContain(outerBare);
      expect((await runtime.resolveApproval(approvalId, 'allow_once')).status).toBe(200);
      await until(async () => (await runtime.getRun(run.id)).run.status === 'COMPLETED', { deadlineMs: E2E_RUN_COMPLETED_BOUND_MS, description: `run ${run.id} COMPLETED` });
      const ended = runtime.events(run.id);
      const frames = await ended.toEnd(E2E_MARGIN_MS);
      await ended.close();
      expect(outputsOf(frames, 'GitPush').join('\n')).not.toMatch(/did not reach its goal|was not run|refused/);
      expect(gitAt(home, innerBare, 'log', '-1', '--format=%s', BRANCH)).toBe('Add the second widget');
      expect(() => gitAt(home, outerBare, 'rev-parse', '--verify', '-q', BRANCH)).toThrow();
    } finally {
      await runtime.close();
    }
  });

  it.skipIf(skipCase('gitpr-delegated-pre-push'))(titleOf('gitpr-delegated-pre-push'), { timeout: E2E_TEST_TIMEOUT_MS }, async (context) => {
    sandboxOrSkip(context);
    const home = await createE2eHome();
    const bare = path.join(home.project, 'remote.git');
    initRepository(home, home.project, bare, bare);
    const hooks = path.join(home.project, 'hooks');
    const marker = path.join(home.project, 'pre-push-ran');
    fs.mkdirSync(hooks);
    fs.writeFileSync(path.join(hooks, 'pre-push'), `#!/bin/sh\necho "$1" >> ${marker}\n[ "$(git rev-parse --abbrev-ref HEAD)" != refused ]\n`, { mode: 0o755 });
    gitAt(home, home.project, 'config', 'core.hooksPath', hooks);
    gitAt(home, home.project, 'switch', '-q', '-c', BRANCH);
    fs.writeFileSync(path.join(home.project, 'widgets.txt'), 'one\ntwo\n');
    gitAt(home, home.project, 'commit', '-q', '-am', 'Add the second widget');
    gitAt(home, home.project, 'branch', 'refused');
    await startStack({
      home,
      settings: { models: localModels(home) },
      script: [toolCallReply('GitPush', { remote: 'origin', branch: BRANCH }, 'call_push'), toolCallReply('GitBranch', { name: 'refused' }, 'call_switch'), toolCallReply('GitPush', { remote: 'origin', branch: 'refused' }, 'call_push_refused'), textReply('done')],
    });
    const runtime = createRuntimeClient(home);
    try {
      await trustProject(runtime, home);
      const { frames } = await runToEnd(runtime, 'Push the branch', ['GitPush', 'GitBranch']);
      expect(fs.readFileSync(marker, 'utf8').split('\n').filter((line) => line !== '')).toEqual(['origin', 'origin']);
      expect(gitAt(home, bare, 'log', '-1', '--format=%s', BRANCH)).toBe('Add the second widget');
      expect(() => gitAt(home, bare, 'rev-parse', '--verify', '-q', 'refused')).toThrow();
      expect(outputsOf(frames, 'GitPush')).toHaveLength(2);
    } finally {
      await runtime.close();
    }
  });

  it.skipIf(process.platform !== 'linux' || skipCase('gitpr-delegated-hosts-relay'))(titleOf('gitpr-delegated-hosts-relay'), { timeout: E2E_TEST_TIMEOUT_MS }, async (context) => {
    sandboxOrSkip(context);
    const home = await createE2eHome();
    const forge = await startForge();
    const bare = path.join(home.project, 'remote.git');
    initRepository(home, home.project, bare, bare);
    gitAt(home, home.project, 'remote', 'add', 'granted', `${forge.origin}/acme/widgets.git`);
    gitAt(home, home.project, 'remote', 'add', 'ungranted', 'https://code.example.invalid/acme/widgets.git');
    await startStack({
      home,
      settings: { ...forgeSettings(forge), models: localModels(home) },
      script: [toolCallReply('GitPush', { remote: 'granted', branch: 'main' }, 'call_push_granted'), toolCallReply('GitPush', { remote: 'ungranted', branch: 'main' }, 'call_push_ungranted'), textReply('done')],
    });
    const runtime = createRuntimeClient(home);
    try {
      await trustProject(runtime, home);
      const { frames } = await runToEnd(runtime, 'Push main', ['GitPush']);
      expect(forge.requests.some((request) => request.path.includes('acme/widgets.git'))).toBe(true);
      const pushes = outputsOf(frames, 'GitPush');
      expect(pushes, allOutputsOf(frames)).toHaveLength(2);
      expect(pushes[0]).not.toMatch(/code\.example\.invalid/);
      expect(pushes[1]).toMatch(/code\.example\.invalid.*CONNECT tunnel failed, response 502/s);
    } finally {
      await runtime.close();
    }
  });
});
