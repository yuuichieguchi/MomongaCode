import { execFileSync } from '@momonga/testkit/child-process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { startFakeForge } from '@momonga/testkit';
import type { FakeForge, Fault } from '@momonga/testkit';
import { skipCase, titleOf } from './support/cases.ts';
import { E2E_SECRETS_FILE_NAME } from './support/gateway-secrets-main.ts';
import { createE2eHome, registerE2eCleanup } from './support/home.ts';
import type { E2eHome } from './support/home.ts';
import { createRuntimeClient, framesOfType } from './support/runtime-client.ts';
import { sandboxOrSkip } from './support/sandbox.ts';
import { DEFAULT_E2E_DEPS, startStack } from './support/stack.ts';
import { childOf } from './support/supervisor-client.ts';
import { textReply, toolCallReply } from './support/upstream.ts';
import { E2E_MARGIN_MS, E2E_RECOVERY_BOUND_MS, E2E_RESTART_POLICY, E2E_RUN_COMPLETED_BOUND_MS, E2E_TEST_TIMEOUT_MS, until } from './support/wait.ts';

const FORGE_SECRET = 'forge-main';
const FORGE_CREDENTIAL = 'e2e-forge-credential-4c1d9a7e';
const COMMIT_MESSAGE = 'Add two';
const HEAD_BRANCH = 'feature/x';

const linesOf = (file: string): string[] => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter((line) => line !== '') : []);

const gitIn = (home: E2eHome, ...args: string[]): string =>
  execFileSync('git', args, {
    cwd: home.project,
    encoding: 'utf8',
    env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: home.home, LANG: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
  }).trim();

const initRepository = (home: E2eHome, origin: string): string => {
  gitIn(home, 'init', '-q', '--initial-branch=main');
  gitIn(home, 'config', 'user.name', 'Momonga E2E');
  gitIn(home, 'config', 'user.email', 'e2e@example.invalid');
  gitIn(home, 'remote', 'add', 'origin', origin);
  fs.writeFileSync(path.join(home.project, 'a.txt'), 'one\n');
  gitIn(home, 'add', 'a.txt');
  gitIn(home, 'commit', '-q', '-m', 'base');
  return gitIn(home, 'rev-parse', 'HEAD');
};

const killRuntime = async (stack: Awaited<ReturnType<typeof startStack>>): Promise<void> => {
  const pid = childOf(await stack.client.health(), 'runtime').pid;
  if (pid === undefined) throw new Error('runtime has no pid');
  process.kill(pid, 'SIGKILL');
};

const loadThen = (name: string, args: Readonly<Record<string, unknown>>) => [toolCallReply('LoadTools', { names: [name] }, 'call_load'), toolCallReply(name, args, 'call_effect'), textReply('done')];

const effectFramesOf = (frames: Awaited<ReturnType<ReturnType<ReturnType<typeof createRuntimeClient>['events']>['toEnd']>>, operation: string) =>
  [...framesOfType(frames, 'tool.completed'), ...framesOfType(frames, 'tool.reconciled')]
    .map((frame) => frame.data['effect'] as { operation: string; target: string; outcome: string } | undefined)
    .filter((effect) => effect?.operation === operation);

describe('gitpr: a runtime SIGKILL at a step of a git or pull request operation', () => {
  it.skipIf(skipCase('gitpr-commit-kill'))(titleOf('gitpr-commit-kill'), { timeout: E2E_TEST_TIMEOUT_MS }, async (context) => {
    sandboxOrSkip(context);
    const home = await createE2eHome();
    const base = initRepository(home, path.join(home.root, 'remote.git'));
    const runs = path.join(home.project, 'hook-runs.log');
    fs.writeFileSync(path.join(home.project, '.git', 'hooks', 'pre-commit'), `#!/bin/sh\necho run >> ${runs}\n[ "$(wc -l < ${runs} | tr -d ' ')" -gt 1 ] || sleep 60\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(home.project, 'a.txt'), 'two\n');
    gitIn(home, 'add', 'a.txt');
    const stack = await startStack({ home, needsBash: true, deps: { ...DEFAULT_E2E_DEPS, restart: E2E_RESTART_POLICY }, script: loadThen('GitCommit', { message: COMMIT_MESSAGE }) });
    const runtime = createRuntimeClient(home);
    try {
      const { session } = await runtime.createSession();
      const { run } = await runtime.createRun(session.id, 'Commit the staged change');
      await until(() => linesOf(runs).length === 1, { deadlineMs: E2E_RECOVERY_BOUND_MS, description: 'the commit hook of the first attempt has started' });
      expect(gitIn(home, 'rev-parse', 'HEAD')).toBe(base);

      await killRuntime(stack);

      await until(async () => (await runtime.getRun(run.id)).run.status === 'COMPLETED', { deadlineMs: E2E_RUN_COMPLETED_BOUND_MS, description: `run ${run.id} COMPLETED after recovery` });
      expect(gitIn(home, 'rev-list', '--count', 'HEAD')).toBe('2');
      expect(gitIn(home, 'rev-parse', 'HEAD^')).toBe(base);
      expect(gitIn(home, 'log', '-1', '--format=%s')).toBe(COMMIT_MESSAGE);
      expect(linesOf(runs)).toEqual(['run', 'run']);
      const stream = runtime.events(run.id);
      const frames = await stream.toEnd(E2E_MARGIN_MS);
      await stream.close();
      expect(effectFramesOf(frames, 'GitCommit').map((effect) => effect?.outcome)).toEqual(['applied']);
      expect(childOf(await stack.client.health(), 'runtime').restarts).toBe(1);
    } finally {
      await runtime.close();
    }
  });

  const pullRequestCase = async (fault: Fault): Promise<{ forge: FakeForge; outcomes: Array<string | undefined>; reconciledOutput: string[] }> => {
    const home = await createE2eHome();
    const forge = await startFakeForge('hub', FORGE_CREDENTIAL);
    registerE2eCleanup(() => forge.close());
    const head = initRepository(home, `${forge.origin}/acme/widgets.git`);
    forge.branchSha.set(HEAD_BRANCH, head);
    forge.faultNext('create', fault);
    fs.writeFileSync(path.join(home.root, E2E_SECRETS_FILE_NAME), JSON.stringify({ [FORGE_SECRET]: FORGE_CREDENTIAL }), { mode: 0o600 });
    const stack = await startStack({
      home,
      deps: { ...DEFAULT_E2E_DEPS, restart: E2E_RESTART_POLICY },
      settings: { forges: [{ id: 'local', descriptor: 'github', host: forge.host, apiBaseUrl: forge.origin, credentialSecret: FORGE_SECRET }] },
      script: loadThen('PullRequestCreate', { head: HEAD_BRANCH, base: 'main', title: 'Add x', body: 'Adds x', headSha: head }),
    });
    const runtime = createRuntimeClient(home);
    try {
      const { session } = await runtime.createSession();
      const { run } = await runtime.createRun(session.id, 'Open the pull request');
      await until(() => forge.creates() === 1, { deadlineMs: E2E_RECOVERY_BOUND_MS, description: 'the create request reached the forge' });

      await killRuntime(stack);

      await until(async () => (await runtime.getRun(run.id)).run.status === 'COMPLETED', { deadlineMs: E2E_RUN_COMPLETED_BOUND_MS, description: `run ${run.id} COMPLETED after recovery` });
      const stream = runtime.events(run.id);
      const frames = await stream.toEnd(E2E_MARGIN_MS);
      await stream.close();
      expect(JSON.stringify(frames)).not.toContain(FORGE_CREDENTIAL);
      return {
        forge,
        outcomes: effectFramesOf(frames, 'PullRequestCreate').map((effect) => effect?.outcome),
        reconciledOutput: framesOfType(frames, 'tool.reconciled').map((frame) => String(frame.data['output'])),
      };
    } finally {
      await runtime.close();
    }
  };

  it.skipIf(skipCase('gitpr-create-response-lost'))(titleOf('gitpr-create-response-lost'), { timeout: E2E_TEST_TIMEOUT_MS }, async () => {
    const { forge, outcomes, reconciledOutput } = await pullRequestCase('apply_then_hold');
    expect(forge.creates()).toBe(1);
    expect(forge.openPullsFor(HEAD_BRANCH, 'main')).toHaveLength(1);
    expect(outcomes).toEqual(['already_applied']);
    expect(reconciledOutput.join('\n')).toContain(forge.urlOf(1));
  });

  it.skipIf(skipCase('gitpr-create-in-flight'))(titleOf('gitpr-create-in-flight'), { timeout: E2E_TEST_TIMEOUT_MS }, async () => {
    const { forge, outcomes } = await pullRequestCase('hold_before_apply');
    expect(forge.creates()).toBe(2);
    expect(forge.openPullsFor(HEAD_BRANCH, 'main')).toHaveLength(1);
    expect(outcomes).toEqual(['applied']);
  });
});
