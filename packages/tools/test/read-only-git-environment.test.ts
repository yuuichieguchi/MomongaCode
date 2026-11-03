import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { REAL_PROCESS_TEST_TIMEOUT_MS } from '@momonga/testkit';
import { makeBuiltins, resultOf } from './builtins/fixtures.ts';
import { makeLayout } from './helpers.ts';
import { makeRealWorkspace } from './real-workspace.ts';
import type { RealWorkspace } from './real-workspace.ts';
import { CLEARED_GIT_VARIABLES, HAS_REAL_SANDBOX, REQUIRED_GIT_KEYS, configuredKeys, realSandbox, recordingSandbox, scratchRootOf } from './read-only-support.ts';

const forced = vi.hoisted(() => ({ decision: { kind: 'allow', source: 'mode', reason: 'forced by the test', basis: 'read_only' } }));

vi.mock('@momonga/policy', async (original) => ({ ...(await original<typeof import('@momonga/policy')>()), decide: () => forced.decision }));

type GitEnv = Record<string, string | undefined>;

const callEnvironment = async (parent: Record<string, string> = {}): Promise<GitEnv> => {
  const recorded = recordingSandbox(realSandbox(scratchRootOf(makeLayout().root)));
  const built = await makeBuiltins({ sandbox: recorded.sandbox });
  resultOf(await built.run('Bash', { command: 'pwd' }, { env: { PATH: '/usr/bin:/bin', LANG: 'C', ...parent } }));
  return { ...(recorded.spawns[0]?.command.env as GitEnv) };
};

const runGit = (env: GitEnv, cwd: string, args: readonly string[], tty: boolean): Promise<void> =>
  new Promise((resolve) => {
    const [file, argv] = !tty
      ? ['/usr/bin/git', [...args]]
      : process.platform === 'darwin'
        ? ['/usr/bin/script', ['-q', '/dev/null', '/usr/bin/git', ...args]]
        : ['/usr/bin/script', ['-qc', `/usr/bin/git ${args.join(' ')}`, '/dev/null']];
    const child = spawn(file as string, argv as string[], { cwd, env: env as NodeJS.ProcessEnv, stdio: 'ignore' });
    child.once('close', () => resolve());
  });

type Plant = { script: string; fired(): boolean; reset(): void };

const plantIn = (workspace: RealWorkspace): Plant => {
  const marker = path.join(workspace.outside, 'fired');
  const script = path.join(workspace.outside, 'planted');
  fs.writeFileSync(script, `#!/bin/sh\n: > ${marker}\n`, { mode: 0o755 });
  return { script, fired: () => fs.existsSync(marker), reset: () => fs.rmSync(marker, { force: true }) };
};

const configure = (workspace: RealWorkspace, key: string, value: string, cwd = workspace.project): void => {
  const result = workspace.git(cwd, 'config', key, value);
  if (result.status !== 0) throw new Error(result.stderr);
};

const withSignature = (workspace: RealWorkspace, armor: readonly string[]): void => {
  const commit = workspace.git(workspace.project, 'cat-file', 'commit', 'HEAD').stdout;
  const [head, ...body] = commit.split('\n\n');
  const header = `gpgsig ${armor.join('\n ')}`;
  const file = workspace.write('../outside/signed-commit', `${head}\n${header}\n\n${body.join('\n\n')}`);
  const hash = workspace.git(workspace.project, 'hash-object', '-t', 'commit', '-w', file).stdout.trim();
  if (workspace.git(workspace.project, 'update-ref', 'HEAD', hash).status !== 0) throw new Error('update-ref failed');
};

const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

const authenticatingServer = async (): Promise<string> => {
  const server = http.createServer((_request, response) => {
    response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="r"' });
    response.end();
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/r.git`;
};

type Row = {
  id: string;
  plant(workspace: RealWorkspace, plant: Plant): Promise<Partial<Record<string, string>> | void> | Partial<Record<string, string>> | void;
  args(workspace: RealWorkspace, plant: Plant): Promise<string[]> | string[];
  tty?: true;
};

const change = (workspace: RealWorkspace): void => void workspace.write('tracked', 'changed\n');

const askingRemote = async (): Promise<string[]> => ['ls-remote', await authenticatingServer()];

const missingBlob = (workspace: RealWorkspace): string => workspace.git(workspace.project, 'rev-parse', 'HEAD:tracked').stdout.trim();

const asPartialClone = (workspace: RealWorkspace, url: string): void => {
  const hash = missingBlob(workspace);
  fs.rmSync(path.join(workspace.project, '.git', 'objects', hash.slice(0, 2), hash.slice(2)));
  configure(workspace, 'core.repositoryformatversion', '1');
  configure(workspace, 'extensions.partialclone', 'origin');
  configure(workspace, 'remote.origin.promisor', 'true');
  configure(workspace, 'remote.origin.url', url);
};

const readMissingBlob = (workspace: RealWorkspace): string[] => ['cat-file', '-p', missingBlob(workspace)];

const SIGNATURE_ROWS: readonly Row[] = [
  { id: 'gpg.program', plant: (w, p) => (configure(w, 'gpg.program', p.script), withSignature(w, ['-----BEGIN PGP SIGNATURE-----', '', 'AAAA', '-----END PGP SIGNATURE-----'])), args: () => ['log', '--show-signature', '-1'] },
  {
    id: 'gpg.ssh.program',
    plant: (w, p) => {
      configure(w, 'gpg.ssh.program', p.script);
      configure(w, 'gpg.ssh.allowedSignersFile', w.write('../outside/allowed', ''));
      withSignature(w, ['-----BEGIN SSH SIGNATURE-----', 'AAAA', '-----END SSH SIGNATURE-----']);
    },
    args: () => ['log', '--show-signature', '-1'],
  },
  { id: 'gpg.x509.program', plant: (w, p) => (configure(w, 'gpg.x509.program', p.script), withSignature(w, ['-----BEGIN SIGNED MESSAGE-----', 'AAAA', '-----END SIGNED MESSAGE-----'])), args: () => ['log', '--show-signature', '-1'] },
];

const KEY_ROWS: readonly Row[] = [
  { id: 'core.fsmonitor', plant: (w, p) => configure(w, 'core.fsmonitor', p.script), args: () => ['status'] },
  {
    id: 'core.fsmonitor in a submodule',
    plant: (w, p) => {
      w.initRepository('sm');
      configure(w, 'core.fsmonitor', p.script, path.join(w.project, 'sm'));
      w.git(w.project, 'add', 'sm');
      w.write('sm/extra', '');
    },
    args: () => ['status'],
  },
  {
    id: 'core.hooksPath',
    plant: (w, p) => {
      const hooks = w.mkdir('../outside/hooks');
      fs.copyFileSync(p.script, path.join(hooks, 'pre-commit'));
      configure(w, 'core.hooksPath', hooks);
    },
    args: () => ['commit', '--allow-empty', '-m', 'x'],
  },
  { id: 'a hook in the default directory', plant: (w, p) => fs.copyFileSync(p.script, path.join(w.project, '.git', 'hooks', 'pre-commit')), args: () => ['commit', '--allow-empty', '-m', 'x'] },
  { id: 'core.pager', tty: true, plant: (w, p) => configure(w, 'core.pager', p.script), args: () => ['-p', 'log', '-1'] },
  { id: 'pager.log', tty: true, plant: (w, p) => configure(w, 'pager.log', p.script), args: () => ['log', '-1'] },
  { id: 'core.editor', plant: (w, p) => configure(w, 'core.editor', p.script), args: () => ['commit', '--allow-empty'] },
  { id: 'pager.diff', tty: true, plant: (w, p) => (configure(w, 'pager.diff', p.script), change(w)), args: () => ['diff'] },
  { id: 'pager.show', tty: true, plant: (w, p) => configure(w, 'pager.show', p.script), args: () => ['show'] },
  { id: 'pager.status', tty: true, plant: (w, p) => configure(w, 'pager.status', p.script), args: () => ['status'] },
  { id: 'core.sshCommand', plant: (w, p) => configure(w, 'core.sshCommand', p.script), args: () => ['ls-remote', 'ssh://example.invalid/r'] },
  { id: 'core.gitProxy', plant: (w, p) => configure(w, 'core.gitProxy', p.script), args: () => ['ls-remote', 'git://example.invalid/r'] },
  { id: 'core.askPass', plant: (w, p) => (configure(w, 'core.askPass', p.script), undefined), args: askingRemote },
  { id: 'credential.helper', plant: (w, p) => (configure(w, 'credential.helper', `!${p.script}`), undefined), args: askingRemote },
  ...SIGNATURE_ROWS,
  { id: 'protocol.allow', plant: (w) => configure(w, 'protocol.allow', 'always'), args: (_w, p) => ['ls-remote', `ext::${p.script}`] },
  { id: 'protocol.ext.allow', plant: (w) => configure(w, 'protocol.ext.allow', 'always'), args: (_w, p) => ['ls-remote', `ext::${p.script}`] },
  {
    id: 'core.alternateRefsCommand',
    plant: (w, p) => {
      w.initRepository('../outside/lender');
      w.write('.git/objects/info/alternates', `${path.join(w.outside, 'lender', '.git', 'objects')}\n`);
      configure(w, 'core.alternateRefsCommand', p.script);
    },
    args: () => ['log', '--alternate-refs', '-1'],
  },
];

const VARIABLE_ROWS: readonly Row[] = [
  {
    id: 'GIT_ALLOW_PROTOCOL with a lazy fetch of ext::',
    plant: (w, p) => {
      asPartialClone(w, `ext::${p.script}`);
      return { GIT_ALLOW_PROTOCOL: 'ext' };
    },
    args: (w) => readMissingBlob(w),
  },
  {
    id: 'a protocol name that is not listed, with a lazy fetch',
    plant: (w, p) => {
      const helpers = w.mkdir('../outside/helpers');
      fs.copyFileSync(p.script, path.join(helpers, 'git-remote-foo'));
      fs.chmodSync(path.join(helpers, 'git-remote-foo'), 0o755);
      asPartialClone(w, 'foo::x');
      configure(w, 'protocol.foo.allow', 'always');
      return { PATH: `${helpers}:/usr/bin:/bin` };
    },
    args: (w) => readMissingBlob(w),
  },
  { id: 'GIT_EXTERNAL_DIFF', plant: (w, p) => (change(w), { GIT_EXTERNAL_DIFF: p.script }), args: () => ['diff'] },
  { id: 'GIT_PAGER', tty: true, plant: (_w, p) => ({ GIT_PAGER: p.script }), args: () => ['-p', 'log', '-1'] },
  { id: 'GIT_EDITOR', plant: (_w, p) => ({ GIT_EDITOR: p.script }), args: () => ['commit', '--allow-empty'] },
  { id: 'GIT_SSH', plant: (_w, p) => ({ GIT_SSH: p.script }), args: () => ['ls-remote', 'ssh://example.invalid/r'] },
  { id: 'GIT_SSH_COMMAND', plant: (_w, p) => ({ GIT_SSH_COMMAND: p.script }), args: () => ['ls-remote', 'ssh://example.invalid/r'] },
  { id: 'GIT_PROXY_COMMAND', plant: (_w, p) => ({ GIT_PROXY_COMMAND: p.script }), args: () => ['ls-remote', 'git://example.invalid/r'] },
  {
    id: 'GIT_EXEC_PATH',
    plant: (w, p) => {
      const helpers = w.mkdir('../outside/helpers');
      fs.copyFileSync(p.script, path.join(helpers, 'git-remote-planted'));
      fs.chmodSync(path.join(helpers, 'git-remote-planted'), 0o755);
      return { GIT_EXEC_PATH: helpers };
    },
    args: () => ['ls-remote', 'planted::anything'],
  },
  { id: 'GIT_ASKPASS', plant: (_w, p) => ({ GIT_ASKPASS: p.script }), args: askingRemote },
  { id: 'GIT_CONFIG_PARAMETERS', plant: (_w, p) => ({ GIT_CONFIG_PARAMETERS: `'core.fsmonitor=${p.script}'` }), args: () => ['status'] },
  { id: 'an inherited GIT_CONFIG_COUNT', plant: (_w, p) => ({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.fsmonitor', GIT_CONFIG_VALUE_0: p.script }), args: () => ['status'] },
];

describe.runIf(HAS_REAL_SANDBOX)('rule 3: the environment of a read-only call, with decide forced to approve', { timeout: REAL_PROCESS_TEST_TIMEOUT_MS }, () => {
  it('sets every key of the rule, optional locks off and prompts off', async () => {
    const env = await callEnvironment();
    expect(configuredKeys(env)).toEqual(expect.arrayContaining([...REQUIRED_GIT_KEYS]));
    expect(env['GIT_OPTIONAL_LOCKS']).toBe('0');
    expect(env['GIT_TERMINAL_PROMPT']).toBe('0');
  });

  it('clears the program variables, whatever the parent environment holds', async () => {
    const env = await callEnvironment(Object.fromEntries(CLEARED_GIT_VARIABLES.map((name) => [name, '/planted'])));
    for (const name of CLEARED_GIT_VARIABLES) expect(env[name] ?? '').toBe('');
  });

  it('forbids lazy fetching', async () => {
    expect((await callEnvironment())['GIT_NO_LAZY_FETCH']).toBe('1');
  });

  it('reads the repository the analysis judged, whatever repository variables the parent holds', async () => {
    const workspace = makeRealWorkspace();
    workspace.initRepository();
    const other = workspace.initRepository('../outside/other');
    const parent = { HOME: workspace.home, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_DIR: path.join(other, '.git'), GIT_WORK_TREE: other, GIT_INDEX_FILE: path.join(other, '.git', 'index') };
    const env = await callEnvironment(parent);
    const reported = execFileSync('/usr/bin/git', ['rev-parse', '--absolute-git-dir'], { cwd: workspace.project, env: env as NodeJS.ProcessEnv, encoding: 'utf8' }).trim();
    expect(reported).toBe(path.join(workspace.project, '.git'));
  });

  it('keeps GIT_PAGER at cat, whatever the parent environment holds', async () => {
    expect((await callEnvironment({ GIT_PAGER: '/planted' }))['GIT_PAGER']).toBe('cat');
  });

  it('replaces inherited configuration entries instead of appending to them', async () => {
    const env = await callEnvironment({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.fsmonitor', GIT_CONFIG_VALUE_0: '/planted', GIT_CONFIG_KEY_9999: 'x', GIT_CONFIG_VALUE_9999: 'y' });
    expect(env['GIT_CONFIG_COUNT']).toBe(String(configuredKeys(env).length));
    expect(env['GIT_CONFIG_KEY_9999']).toBeUndefined();
    expect(Object.values(env)).not.toContain('/planted');
  });

  it('git log --alternate-refs prints the same with the call environment as with the plain one', async () => {
    const workspace = makeRealWorkspace();
    workspace.initRepository();
    workspace.initRepository('../outside/lender');
    workspace.write('.git/objects/info/alternates', `${path.join(workspace.outside, 'lender', '.git', 'objects')}\n`);
    const env = await callEnvironment({ HOME: workspace.home, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' });
    const run = (environment: GitEnv): string => execFileSync('/usr/bin/git', ['log', '--alternate-refs', '--oneline', '-3'], { cwd: workspace.project, env: environment as NodeJS.ProcessEnv, encoding: 'utf8' });
    expect(run(env)).toBe(run(workspace.env()));
  });

  it.each([...KEY_ROWS, ...VARIABLE_ROWS])('$id: the planted program starts under the plain environment and not under the call environment', async (row) => {
    const workspace = makeRealWorkspace();
    workspace.initRepository();
    const plant = plantIn(workspace);
    const parent = ((await row.plant(workspace, plant)) ?? {}) as Record<string, string>;
    const args = await row.args(workspace, plant);
    await runGit({ ...workspace.env(), GIT_TERMINAL_PROMPT: '0', ...parent }, workspace.project, args, row.tty === true);
    expect(plant.fired()).toBe(true);
    plant.reset();

    const env = await callEnvironment({ ...parent, HOME: workspace.home, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' });
    await runGit(env, workspace.project, args, row.tty === true);
    expect(plant.fired()).toBe(false);
  });

  describe('keys with no neutral value cannot be overridden through the environment and stay with the analysis', () => {
    const DRIVERS: readonly Row[] = [
      { id: 'diff.external', plant: (w, p) => (configure(w, 'diff.external', p.script), change(w), undefined), args: () => ['diff'] },
      { id: 'diff.<driver>.command', plant: (w, p) => (configure(w, 'diff.planted.command', p.script), w.write('.gitattributes', 'tracked diff=planted\n'), change(w), undefined), args: () => ['diff'] },
      { id: 'diff.<driver>.textconv', plant: (w, p) => (configure(w, 'diff.planted.textconv', p.script), w.write('.gitattributes', 'tracked diff=planted\n'), change(w), undefined), args: () => ['diff'] },
      { id: 'filter.<driver>.clean', plant: (w, p) => (configure(w, 'filter.planted.clean', p.script), w.write('.gitattributes', 'tracked filter=planted\n'), change(w), undefined), args: () => ['diff'] },
    ];

    it.each(DRIVERS)('$id still starts under the call environment', async (row) => {
      const workspace = makeRealWorkspace();
      workspace.initRepository();
      const plant = plantIn(workspace);
      await row.plant(workspace, plant);
      const env = await callEnvironment({ HOME: workspace.home, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' });
      await runGit(env, workspace.project, await row.args(workspace, plant), false);
      expect(plant.fired()).toBe(true);
    });
  });

  it('git status and git diff print the same with an index that cannot be refreshed', async () => {
    const workspace = makeRealWorkspace();
    workspace.initRepository();
    workspace.write('tracked', 'one\n');
    const future = new Date(4_000_000_000_000);
    fs.utimesSync(path.join(workspace.project, 'tracked'), future, future);
    const env = await callEnvironment({ HOME: workspace.home, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' });
    expect(env['GIT_OPTIONAL_LOCKS']).toBe('0');
    const index = fs.readFileSync(path.join(workspace.project, '.git', 'index'));
    await runGit(env, workspace.project, ['status'], false);
    expect(fs.readFileSync(path.join(workspace.project, '.git', 'index')).equals(index)).toBe(true);
  });
});
