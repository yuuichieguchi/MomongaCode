import { spawnSync } from '@momonga/testkit/child-process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { EMPTY_GLOB_TABLE, computeFileRules, decide, settleGlobs } from '@momonga/policy';
import { discoverGitConfigFiles, protectedSetFor, ruleEnforcementOf } from '@momonga/foundation';
import { TEST_SEARCH_PATH, isWritableFor } from '@momonga/testkit';
import { REAL_PROCESS_TEST_TIMEOUT_MS } from '@momonga/testkit';
import { buildSandboxPolicy, createPolicyFilesystem } from '@momonga/tools';
import { HAS_REAL_SANDBOX, HOST_SANDBOX_KIND, createHostSandbox } from '../helpers.ts';
import { makeRealWorkspace } from '../real-workspace.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const OTHER = 'file:///elsewhere/other.git';

const gitFilesOf = (directory: string): string => ['config', 'config.worktree'].map((name) => (fs.existsSync(path.join(directory, '.git', name)) ? fs.readFileSync(path.join(directory, '.git', name), 'utf8') : '')).join('\n');

describe.skipIf(!HAS_REAL_SANDBOX)('repointing the remote of a repository (default policy and sandbox)', () => {
  const setup = () => {
    const workspace = makeRealWorkspace();
    workspace.initRepository();
    workspace.git(workspace.project, 'remote', 'add', 'origin', `file://${workspace.base}/origin.git`);
    const roots = [workspace.project];
    const tmpDir = path.join(workspace.base, 'sessions', 'session-1');
    for (const directory of [tmpDir, path.join(workspace.base, 'sandbox-tmp')]) fs.mkdirSync(directory, { recursive: true });
    const sandbox = createHostSandbox({ tmpRoot: path.join(workspace.base, 'sandbox-tmp'), killGraceMs: 300 });
    const policy = buildSandboxPolicy({
      roots,
      home: workspace.home,
      tmpDir,
      sessionsTmpRoot: path.join(workspace.base, 'sessions'),
      fileRules: computeFileRules([], roots, tmpDir, ruleEnforcementOf(HOST_SANDBOX_KIND)),
      protectedSet: protectedSetFor(roots, createPolicyFilesystem()),
      network: 'deny',
    });
    const inSandbox = async (script: string): Promise<{ code: number | null; stderr: string }> => {
      const proc = sandbox.spawn({ argv: ['/bin/bash', '-c', script], cwd: workspace.project, env: { ...workspace.env(), PATH: workspace.env()['PATH'] ?? '' } as Record<string, string> }, policy, new AbortController().signal);
      const chunks: Buffer[] = [];
      for await (const chunk of proc.stderr) chunks.push(Buffer.from(chunk));
      for await (const chunk of proc.stdout) void chunk;
      const exit = await proc.exited;
      return { code: exit.code, stderr: Buffer.concat(chunks).toString('utf8') };
    };
    return { workspace, inSandbox };
  };

  const ROUTES: ReadonlyArray<readonly [string, (workspace: ReturnType<typeof makeRealWorkspace>) => string]> = [
    ['git remote set-url', () => `git remote set-url origin ${OTHER}`],
    ['git config remote.origin.url', () => `git config remote.origin.url ${OTHER}`],
    ['git config url.<other>.insteadOf', (workspace) => `git config url.${OTHER}.insteadOf file://${workspace.base}/origin.git`],
    ['git config remote.origin.pushurl', () => `git config remote.origin.pushurl ${OTHER}`],
    ['git config include.path', (workspace) => `git config include.path ${workspace.base}/outside/extra.config`],
    ['append to .git/config with the shell', () => `printf '[remote "origin"]\\n\\turl = ${OTHER}\\n' >> .git/config`],
    ['git config --global insteadOf', (workspace) => `env -u GIT_CONFIG_GLOBAL HOME=${workspace.home} git config --global url.${OTHER}.insteadOf file://${workspace.base}/origin.git`],
    ['the XDG config of git', (workspace) => `mkdir -p ${workspace.home}/.config/git && env -u GIT_CONFIG_GLOBAL XDG_CONFIG_HOME=${workspace.home}/.config HOME=${workspace.home} git config --global url.${OTHER}.insteadOf file://${workspace.base}/origin.git; git config --file ${workspace.home}/.config/git/config url.${OTHER}.insteadOf file://${workspace.base}/origin.git`],
    ['a global ~/.gitconfig written with the shell', (workspace) => `printf '[url "${OTHER}"]\\n\\tinsteadOf = file://${workspace.base}/origin.git\\n' > ${workspace.home}/.gitconfig`],
  ];

  it.each(ROUTES)('%s: the policy asks a person and the sandbox leaves the configuration unchanged', async (_name, commandFor) => {
    const { workspace, inSandbox } = setup();
    const command = commandFor(workspace);
    const before = gitFilesOf(workspace.project);
    const decision = workspace.decide(command);
    const result = await inSandbox(command);
    const homeFiles = ['.gitconfig', '.config/git/config'].filter((relative) => fs.existsSync(path.join(workspace.home, relative)));
    const changed = gitFilesOf(workspace.project) !== before || homeFiles.length > 0;
    expect({ decision: decision.kind, changed }).toEqual({ decision: 'ask', changed: false });
  });

  it.each(['Write', 'Edit'] as const)('%s on .git/config needs a person, whatever the mode defaults say', (toolName) => {
    const { workspace } = setup();
    expect(workspace.decideWrite(toolName, path.join(workspace.project, '.git', 'config'))).toMatchObject({ kind: 'ask', source: 'protected', humanOnly: true });
  });
});

describe.skipIf(!HAS_REAL_SANDBOX)('repointing the remote when the workspace root contains the git configuration files', () => {
  const setup = async () => {
    const workspace = makeRealWorkspace();
    const home = path.join(workspace.base, 'rooted-home');
    const project = path.join(home, 'project');
    fs.mkdirSync(project, { recursive: true });
    const env: Record<string, string> = { HOME: home, PATH: TEST_SEARCH_PATH, LANG: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
    const git = (...args: string[]): void => {
      const result = spawnSync('/usr/bin/git', args, { cwd: project, env, encoding: 'utf8' });
      if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
    };
    git('init', '-q', '-b', 'main');
    git('remote', 'add', 'origin', `file://${workspace.base}/origin.git`);
    const included = path.join(home, 'included.cfg');
    fs.writeFileSync(included, '[user]\n\tname = t\n');
    git('config', 'include.path', included);
    const roots = [home];
    const tmpDir = path.join(workspace.base, 'sessions', 'session-1');
    for (const directory of [tmpDir, path.join(workspace.base, 'sandbox-tmp')]) fs.mkdirSync(directory, { recursive: true });
    const filesystem = createPolicyFilesystem();
    const gitConfigFiles = await discoverGitConfigFiles({ workingDirectory: project, env, signal: new AbortController().signal });
    const protectedSet = protectedSetFor(roots, filesystem, gitConfigFiles);
    const fileRules = computeFileRules([], roots, tmpDir, ruleEnforcementOf(HOST_SANDBOX_KIND));
    const policy = buildSandboxPolicy({ roots, home, tmpDir, sessionsTmpRoot: path.join(workspace.base, 'sessions'), fileRules, protectedSet, network: 'deny' });
    const sandbox = createHostSandbox({ tmpRoot: path.join(workspace.base, 'sandbox-tmp'), killGraceMs: 300 });
    const inSandbox = async (script: string): Promise<number | null> => {
      const proc = sandbox.spawn({ argv: ['/bin/bash', '-c', script], cwd: project, env }, policy, new AbortController().signal);
      for await (const chunk of proc.stderr) void chunk;
      for await (const chunk of proc.stdout) void chunk;
      return (await proc.exited).code;
    };
    const decision = (tool: { name: string; kind: 'execute' | 'edit'; sideEffect: 'exec' | 'write'; subjectKind: 'command' | 'path' }, subject: Parameters<typeof decide>[0]['subject']) =>
      decide({ tool, subject, mode: 'manual', rules: [], roots, home, cwd: project, fileRules, protectedSet, fs: settleGlobs(filesystem, EMPTY_GLOB_TABLE), searchPath: TEST_SEARCH_PATH, isWritable: isWritableFor(roots) });
    const bash = (command: string) => decision({ name: 'Bash', kind: 'execute', sideEffect: 'exec', subjectKind: 'command' }, { kind: 'command', tool: 'Bash', command });
    const write = (file: string) => decision({ name: 'Write', kind: 'edit', sideEffect: 'write', subjectKind: 'path' }, { kind: 'path', tool: 'Write', paths: [file], access: 'write' });
    return { home, project, included, inSandbox, bash, write, workspace };
  };

  const insteadOf = (workspace: { base: string }): string => `url.file:///elsewhere/other.git.insteadOf file://${workspace.base}/origin.git`;

  it('git config --global needs a person and the sandbox leaves ~/.gitconfig absent', async () => {
    const { home, inSandbox, bash, workspace } = await setup();
    const command = `env -u GIT_CONFIG_GLOBAL git config --global ${insteadOf(workspace)}`;
    expect(bash(command).kind).toBe('ask');
    await inSandbox(command);
    expect(fs.existsSync(path.join(home, '.gitconfig'))).toBe(false);
  });

  it('a Write of ~/.gitconfig is held for a person as a protected path', async () => {
    const { home, write } = await setup();
    expect(write(path.join(home, '.gitconfig'))).toMatchObject({ kind: 'ask', source: 'protected', humanOnly: true });
  });

  it('the XDG git config is protected the same way', async () => {
    const { home, write, inSandbox } = await setup();
    const file = path.join(home, '.config', 'git', 'config');
    expect(write(file)).toMatchObject({ kind: 'ask', source: 'protected' });
    await inSandbox(`mkdir -p ${path.dirname(file)} && printf '[user]\\n' > ${file}`);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('a file named by include.path is protected: a Write is held and the sandbox leaves it unchanged', async () => {
    const { included, write, inSandbox, workspace } = await setup();
    const before = fs.readFileSync(included, 'utf8');
    expect(write(included)).toMatchObject({ kind: 'ask', source: 'protected', humanOnly: true });
    await inSandbox(`printf '[url "file:///elsewhere/other.git"]\\n\\tinsteadOf = file://${workspace.base}/origin.git\\n' >> ${included}`);
    expect(fs.readFileSync(included, 'utf8')).toBe(before);
  });
});
