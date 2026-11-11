import { execFileSync } from '@momonga/testkit/child-process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { REAL_PROCESS_TEST_TIMEOUT_MS } from '@momonga/testkit';
import type { ForgeAccess } from '@momonga/tools';
import { REPOSITORY_KEY_RULES, gitEnvironment, productSetEntriesOf, repositoryKeyRuleOf } from '@momonga/tools';
import { contextFor, countingRunner, makeGitWorld, operationTool, partsOf, remoteSha, settle } from './support.ts';
import type { GitWorld } from './support.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const PUSH = { remote: 'origin', branch: 'main' };

const NETWORK_COMMANDS: readonly string[] = ['ls-remote', 'push', 'fetch'];

const HANDS_OUT_A_CREDENTIAL: ForgeAccess = {
  request: async () => Promise.reject(new Error('no forge request is expected')),
  gitCredential: async (remoteUrl) => ({ origin: URL.canParse(remoteUrl) ? new URL(remoteUrl).origin : 'https://forge.example', username: 'x-access-token', password: 'fake-git-credential-for-tests' }),
  gitDestination: () => undefined,
};

type Planted = { world: GitWorld; fired: string; marker: string };

const plantedWorld = (): Planted => {
  const world = makeGitWorld();
  const fired = path.join(world.base, 'fired');
  const marker = path.join(world.base, 'marker');
  fs.writeFileSync(marker, `#!/bin/sh\necho "$0 $*" >> '${fired}'\nexit 1\n`, { mode: 0o755 });
  world.write('a.txt', 'one\n');
  world.commitAll('base');
  return { world, fired, marker };
};

const attempt = async (world: GitWorld, name: 'GitPush' | 'GitFetch', forge: ForgeAccess = HANDS_OUT_A_CREDENTIAL) => {
  const runner = countingRunner();
  const parts = partsOf(operationTool(name, { runArgv: runner.run, forge }), PUSH, contextFor(world.work, world.env));
  const outcome = await settle(async () => parts.execute(await parts.prepare()));
  return { outcome, runner };
};

const ranOnTheNetwork = (calls: ReadonlyArray<readonly string[]>): boolean => calls.some((argv) => NETWORK_COMMANDS.includes(argv[1] ?? ''));

describe('a repository whose own configuration names a program git starts for the remote, or rewrites the destination', () => {
  it.each([
    ['GitPush', 'remote.origin.receivepack'],
    ['GitFetch', 'remote.origin.uploadpack'],
    ['GitPush', 'remote.origin.uploadpack'],
    ['GitFetch', 'remote.origin.vcs'],
  ] as const)('refuses %s at the gate when the repository sets %s: the key is named and the program never runs', async (name, key) => {
    const { world, fired, marker } = plantedWorld();
    world.git(world.work, 'config', key, marker);
    const { outcome, runner } = await attempt(world, name);
    expect(outcome.status).toBe('threw');
    expect(outcome.output).toContain(`${name} was not run: the configuration of this repository sets ${key}, which names a program git starts for the remote`);
    expect(outcome.output).toContain(`git config --local --unset ${key}`);
    expect(outcome.output).toContain(`git config --global ${key} <value>`);
    expect(ranOnTheNetwork(runner.calls)).toBe(false);
    expect(fs.existsSync(fired)).toBe(false);
  });

  it.each(['insteadOf', 'pushInsteadOf'])('refuses GitPush when the repository rewrites a destination with url.<base>.%s', async (variable) => {
    const { world } = plantedWorld();
    world.git(world.work, 'config', `url./planted/elsewhere.git.${variable}`, world.bare);
    const { outcome, runner } = await attempt(world, 'GitPush');
    expect(outcome.status).toBe('threw');
    expect(outcome.output).toContain(`the configuration of this repository sets url./planted/elsewhere.git.${variable.toLowerCase()}, which rewrites the destination`);
    expect(ranOnTheNetwork(runner.calls)).toBe(false);
    expect(remoteSha(world, 'main')).toBe('0'.repeat(40));
  });

  it('refuses a key the product does not know, with its name', async () => {
    const { world } = plantedWorld();
    world.git(world.work, 'config', 'frobnicate.newSetting', 'anything');
    const { outcome, runner } = await attempt(world, 'GitPush');
    expect(outcome.status).toBe('threw');
    expect(outcome.output).toContain('GitPush was not run: the configuration of this repository sets frobnicate.newsetting, which is not a setting momonga knows to be without effect on a fetch or a push');
    expect(ranOnTheNetwork(runner.calls)).toBe(false);
  });

  it('refuses a file the repository includes, because what it sets is read like the configuration of the repository', async () => {
    const { world, fired, marker } = plantedWorld();
    const included = path.join(world.base, 'included.config');
    fs.writeFileSync(included, `[remote "origin"]\n\treceivepack = ${marker}\n`);
    world.git(world.work, 'config', 'include.path', included);
    const { outcome, runner } = await attempt(world, 'GitPush');
    expect(outcome.status).toBe('threw');
    expect(outcome.output).toMatch(/sets (include\.path|remote\.origin\.receivepack), which/);
    expect(ranOnTheNetwork(runner.calls)).toBe(false);
    expect(fs.existsSync(fired)).toBe(false);
  });

  it('reads the configuration of the work tree as well, and names the scope in the way forward', async () => {
    const { world, fired, marker } = plantedWorld();
    world.git(world.work, 'config', 'extensions.worktreeConfig', 'true');
    world.git(world.work, 'config', '--worktree', 'remote.origin.receivepack', marker);
    const { outcome, runner } = await attempt(world, 'GitPush');
    expect(outcome.status).toBe('threw');
    expect(outcome.output).toContain('git config --worktree --unset remote.origin.receivepack');
    expect(ranOnTheNetwork(runner.calls)).toBe(false);
    expect(fs.existsSync(fired)).toBe(false);
  });

  it('refuses when an interrupted call is looked at again and the repository has gained such a key since', async () => {
    const { world, fired, marker } = plantedWorld();
    const runner = countingRunner();
    const parts = partsOf(operationTool('GitPush', { runArgv: runner.run, forge: HANDS_OUT_A_CREDENTIAL }), PUSH, contextFor(world.work, world.env));
    const prepared = await parts.prepare();
    world.git(world.work, 'config', 'remote.origin.receivepack', marker);
    const before = runner.calls.length;
    await expect(parts.reconcile(prepared, Date.now())).rejects.toThrow('the configuration of this repository sets remote.origin.receivepack, which names a program git starts for the remote');
    expect(ranOnTheNetwork(runner.calls.slice(before))).toBe(false);
    expect(fs.existsSync(fired)).toBe(false);
  });

  it('does not refuse for the same key in the configuration of the person', async () => {
    const { world } = plantedWorld();
    fs.appendFileSync(world.env['GIT_CONFIG_GLOBAL'] as string, '[frobnicate]\n\tnewSetting = mine\n');
    const { outcome } = await attempt(world, 'GitPush');
    expect(outcome.status).toBe('completed');
    expect(remoteSha(world, 'main')).toBe(world.git(world.work, 'rev-parse', 'HEAD'));
  });
});

describe('an ordinary repository', () => {
  it('pushes and fetches as before with a remote, a refspec, branch tracking, an identity and line-ending settings of its own', async () => {
    const { world } = plantedWorld();
    world.git(world.work, 'config', 'user.name', 'A Person');
    world.git(world.work, 'config', 'user.email', 'person@example.invalid');
    world.git(world.work, 'config', 'core.autocrlf', 'input');
    world.git(world.work, 'config', 'branch.main.remote', 'origin');
    world.git(world.work, 'config', 'branch.main.merge', 'refs/heads/main');
    world.git(world.work, 'config', 'branch.main.rebase', 'true');
    world.git(world.work, 'config', 'branch.main.vscode-merge-base', 'origin/main');
    world.git(world.work, 'config', 'pull.rebase', 'true');
    expect(world.git(world.work, 'config', '--get', 'remote.origin.fetch')).toBe('+refs/heads/*:refs/remotes/origin/*');
    const pushed = await attempt(world, 'GitPush');
    expect(pushed.outcome.status).toBe('completed');
    expect(remoteSha(world, 'main')).toBe(world.git(world.work, 'rev-parse', 'HEAD'));
    const fetched = await attempt(world, 'GitFetch');
    expect(fetched.outcome.status).toBe('completed');
    expect(world.git(world.work, 'rev-parse', 'refs/remotes/origin/main')).toBe(world.git(world.work, 'rev-parse', 'HEAD'));
  });
});

describe('a destination that is not on the network', () => {
  it('gets no credential channel: a remote at a local path runs every git process without the credential, whatever the forge would hand out', async () => {
    const { world } = plantedWorld();
    const { outcome, runner } = await attempt(world, 'GitPush');
    expect(outcome.status).toBe('completed');
    expect(remoteSha(world, 'main')).toBe(world.git(world.work, 'rev-parse', 'HEAD'));
    expect(ranOnTheNetwork(runner.calls)).toBe(true);
    expect(runner.credentialed).toEqual(runner.credentialed.map(() => false));
    expect(runner.environments.some((env) => 'GIT_ASKPASS' in env)).toBe(false);
  });

  it('gets none as a file: URL either', async () => {
    const { world } = plantedWorld();
    world.git(world.work, 'remote', 'set-url', 'origin', `file://${world.bare}`);
    const { outcome, runner } = await attempt(world, 'GitPush');
    expect(outcome.status).toBe('completed');
    expect(remoteSha(world, 'main')).toBe(world.git(world.work, 'rev-parse', 'HEAD'));
    expect(runner.credentialed).toEqual(runner.credentialed.map(() => false));
  });

  it('refuses a remote whose push URLs mix a local path with a network URL, because one git process would serve both', async () => {
    const { world } = plantedWorld();
    world.git(world.work, 'remote', 'set-url', '--add', '--push', 'origin', world.bare);
    world.git(world.work, 'remote', 'set-url', '--add', '--push', 'origin', 'https://forge.example/acme/widgets.git');
    const { outcome, runner } = await attempt(world, 'GitPush');
    expect(outcome.status).toBe('threw');
    expect(outcome.output).toContain(`GitPush was not run: the remote origin has push destinations reached over HTTP or HTTPS (https://forge.example/acme/widgets.git) and others (${world.bare})`);
    expect(ranOnTheNetwork(runner.calls)).toBe(false);
  });
});

describe('the one table of the settings a repository may carry into a fetch or a push', () => {
  it('gives every row a reason, and an overridden row the value that wins', () => {
    for (const rule of REPOSITORY_KEY_RULES) {
      expect(rule.why.trim(), rule.key).not.toBe('');
      expect(rule.key, rule.key).toBe(rule.key.toLowerCase());
      if (rule.verdict === 'overridden') expect(repositoryKeyRuleOf(rule.set[0].replace('{destination}', 'x'))?.verdict, rule.key).toBe('overridden');
    }
    expect(new Set(REPOSITORY_KEY_RULES.map((rule) => rule.key)).size).toBe(REPOSITORY_KEY_RULES.length);
  });

  it('judges a key by its section, its subsection and its variable', () => {
    expect(repositoryKeyRuleOf('remote.origin.url')?.verdict).toBe('inert');
    expect(repositoryKeyRuleOf('remote.a.url.receivepack')?.verdict).toBe('refused');
    expect(repositoryKeyRuleOf('remote.receivepack.url')?.verdict).toBe('inert');
    expect(repositoryKeyRuleOf('branch.fix/a.b.vscode-merge-base')?.verdict).toBe('inert');
    expect(repositoryKeyRuleOf('core.hookspath')?.verdict).toBe('overridden');
    expect(repositoryKeyRuleOf('core.autocrlf')?.verdict).toBe('inert');
    expect(repositoryKeyRuleOf('http.https://forge.example/.sslverify')?.verdict).toBe('overridden');
    expect(repositoryKeyRuleOf('http.https://forge.example/.sslcainfo')?.verdict).toBe('refused');
    expect(repositoryKeyRuleOf('http.sslcert')).toBeUndefined();
    expect(repositoryKeyRuleOf('url.https://elsewhere.example/.insteadof')?.verdict).toBe('refused');
    expect(repositoryKeyRuleOf('core.newprogramofalatergit')).toBeUndefined();
    expect(repositoryKeyRuleOf('user.url')?.verdict).toBe('inert');
    expect(repositoryKeyRuleOf('remote.pushdefault')?.verdict).toBe('inert');
    expect(repositoryKeyRuleOf('remote.vcs')).toBeUndefined();
  });

  it('is where the environment of a network git process takes every value it sets over the repository', () => {
    const world = makeGitWorld();
    const destination = 'https://forge.example/acme/widgets.git';
    const alias = { from: 'https://alias.example/acme/widgets.git', to: destination };
    const env = gitEnvironment(world.env, { mode: 'network', destinations: [destination], rewrites: [alias] });
    const count = Number(env['GIT_CONFIG_COUNT']);
    const set = Array.from({ length: count }, (_, index) => [env[`GIT_CONFIG_KEY_${index}`] ?? '', env[`GIT_CONFIG_VALUE_${index}`] ?? ''] as const);
    const produced = productSetEntriesOf([destination], [{ from: destination, to: destination }, alias]);
    expect(set).toEqual(produced.map(({ entry }) => entry));
    for (const { entry, rule } of produced) {
      expect(REPOSITORY_KEY_RULES, entry[0]).toContain(rule);
      expect(repositoryKeyRuleOf(entry[0].replaceAll(destination, 'x').toLowerCase()), entry[0]).toBe(rule);
    }
    expect(produced.filter(({ entry }) => entry[0].startsWith('url.')).map(({ entry }) => entry)).toEqual([
      [`url.${destination}.insteadOf`, destination],
      [`url.${destination}.insteadOf`, alias.from],
      [`url.${destination}.pushInsteadOf`, destination],
      [`url.${destination}.pushInsteadOf`, alias.from],
    ]);
    const effective = (key: string): string => execFileSync('git', ['config', key], { cwd: world.work, env: { ...env }, encoding: 'utf8' }).trim();
    world.git(world.work, 'config', 'fetch.recurseSubmodules', 'true');
    world.git(world.work, 'config', 'submodule.recurse', 'true');
    world.git(world.work, 'config', 'push.recurseSubmodules', 'on-demand');
    expect(effective('fetch.recurseSubmodules')).toBe('false');
    expect(effective('submodule.recurse')).toBe('false');
    expect(effective('push.recurseSubmodules')).toBe('no');
    expect(effective('protocol.https.allow')).toBe('always');
    expect(effective('protocol.ssh.allow')).toBe('never');
  });
});
