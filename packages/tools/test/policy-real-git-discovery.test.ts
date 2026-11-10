import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { REAL_PROCESS_TEST_TIMEOUT_MS } from '@momonga/testkit';
import { makeRealWorkspace } from './real-workspace.ts';
import type { RealWorkspace } from './real-workspace.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const hookIn = (workspace: RealWorkspace): { script: string; fired: () => boolean } => {
  const script = path.join(workspace.base, 'hook.sh');
  const marker = path.join(workspace.base, 'fired');
  fs.writeFileSync(script, `#!/bin/sh\ntouch ${marker}\nprintf '\\0'\n`, { mode: 0o755 });
  return { script, fired: () => fs.existsSync(marker) };
};

const bareLayout = (workspace: RealWorkspace, directory: string, config: string): void => {
  workspace.mkdir(`${directory}/objects`);
  workspace.mkdir(`${directory}/refs`);
  workspace.write(`${directory}/HEAD`, 'ref: refs/heads/main\n');
  workspace.write(`${directory}/config`, config);
};

const fsmonitorConfig = (script: string): string => `[core]\n\trepositoryformatversion = 0\n\tbare = false\n\tworktree = ..\n\tfsmonitor = ${script}\n`;

describe('git discovery as git performs it (real git 2.54, real /bin/bash)', () => {
  it('git --bare takes the working directory as the git directory even when a valid .git is beside it', () => {
    const workspace = makeRealWorkspace();
    const hook = hookIn(workspace);
    workspace.initRepository();
    bareLayout(workspace, '.', fsmonitorConfig(hook.script));

    expect(workspace.git(workspace.project, 'status').status).toBe(0);
    expect(hook.fired()).toBe(false);
    expect(workspace.decide('git status').kind).toBe('allow');

    workspace.git(workspace.project, '--bare', 'status');
    expect(hook.fired()).toBe(true);
    expect(workspace.decide('git --bare status').kind).toBe('ask');
    expect(workspace.decide('git --bare log -1', { mode: 'plan' }).kind).toBe('ask');
  });

  it('a bare layout in a subdirectory is the repository once the shell is there, also inside a nested substitution', () => {
    const workspace = makeRealWorkspace();
    const hook = hookIn(workspace);
    workspace.initRepository();
    bareLayout(workspace, 'sub', fsmonitorConfig(hook.script));

    expect(workspace.runBash('cd sub && echo "$(git status)"').status).toBe(0);
    expect(hook.fired()).toBe(true);

    for (const command of ['cd sub && git status', 'cd sub && echo "$(git status)"', 'cd sub; echo `git status`', 'echo $(cd sub && git status)', 'cd ./sub && echo "$(echo "$(git status)")"']) {
      expect(workspace.decide(command).kind, command).toBe('ask');
    }
    expect(workspace.decide('git status', { cwd: path.join(workspace.project, 'sub') }).kind).toBe('ask');
  });

  it('a cd into an ordinary subdirectory of a repository the workspace root owns is still read-only at any nesting level', () => {
    const workspace = makeRealWorkspace();
    workspace.initRepository();
    workspace.mkdir('plain');
    for (const command of ['cd plain && git status', 'cd plain && echo "$(git status)"', `cd plain; cd ${workspace.project}; echo $(git log -1)`]) {
      expect(workspace.decide(command).kind, command).toBe('allow');
      expect(workspace.runBash(command).status, command).toBe(0);
    }
  });

  it('a directory that names another directory through commondir is a git directory without objects and refs of its own', () => {
    const workspace = makeRealWorkspace();
    const hook = hookIn(workspace);
    workspace.initRepository();
    const real = path.join(workspace.project, '.git');
    const evil = path.join(workspace.project, 'evil');
    fs.cpSync(real, evil, { recursive: true });
    fs.appendFileSync(path.join(evil, 'config'), `[diff "x"]\n\ttextconv = ${hook.script}\n`);
    workspace.write('evil/info/attributes', '* diff=x\n');
    workspace.write('sub/HEAD', 'ref: refs/heads/main\n');
    workspace.write('sub/commondir', '../evil\n');
    const sub = path.join(workspace.project, 'sub');

    expect(workspace.git(sub, 'rev-parse', '--git-dir', '--git-common-dir').stdout).toContain(evil);
    workspace.git(sub, 'log', '-p');
    expect(hook.fired()).toBe(true);

    expect(workspace.decide('git log -p', { cwd: sub }).kind).toBe('ask');
    expect(workspace.decide('cd sub && git log -p').kind).toBe('ask');
  });

  it('a .git directory with a commondir file and no objects of its own is a repository too', () => {
    const workspace = makeRealWorkspace();
    const hook = hookIn(workspace);
    workspace.initRepository('main');
    const evil = path.join(workspace.project, 'evil');
    fs.cpSync(path.join(workspace.project, 'main', '.git'), evil, { recursive: true });
    fs.appendFileSync(path.join(evil, 'config'), `[diff "x"]\n\ttextconv = ${hook.script}\n`);
    workspace.write('evil/info/attributes', '* diff=x\n');
    workspace.write('nest/.git/HEAD', 'ref: refs/heads/main\n');
    workspace.write('nest/.git/commondir', '../../evil\n');
    const nest = path.join(workspace.project, 'nest');
    workspace.git(nest, 'log', '-p');
    expect(hook.fired()).toBe(true);
    expect(workspace.decide('git log -p', { cwd: nest }).kind).toBe('ask');
  });

  it('a commondir with trailing carriage returns and line feeds is followed as git follows it', () => {
    const workspace = makeRealWorkspace();
    workspace.initRepository('main');
    workspace.write('sub/HEAD', 'ref: refs/heads/main\n');
    workspace.write('sub/commondir', '../main/.git\r\n\r\n');
    const sub = path.join(workspace.project, 'sub');
    expect(workspace.git(sub, 'rev-parse', '--git-common-dir').stdout.trim()).toBe(path.join(workspace.project, 'main', '.git'));
    expect(workspace.decide('git log', { cwd: sub }).kind).toBe('ask');
  });
});
