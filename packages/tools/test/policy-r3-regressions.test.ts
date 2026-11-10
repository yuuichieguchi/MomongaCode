import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { REAL_PROCESS_TEST_TIMEOUT_MS } from '@momonga/testkit';
import { signHead } from './differential/fixture.ts';
import { makeRealWorkspace } from './real-workspace.ts';
import type { RealWorkspace } from './real-workspace.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const hookIn = (workspace: RealWorkspace): { script: string; fired: () => boolean } => {
  const script = path.join(workspace.base, 'hook.sh');
  const marker = path.join(workspace.base, 'fired');
  fs.writeFileSync(script, `#!/bin/sh\ntouch ${marker}\nprintf '\\0'\n`, { mode: 0o755 });
  return { script, fired: () => fs.existsSync(marker) };
};

const fsmonitorConfig = (script: string): string => `[core]\n\trepositoryformatversion = 0\n\tbare = false\n\tworktree = ..\n\tfsmonitor = ${script}\n`;

const bareLayout = (workspace: RealWorkspace, directory: string, head: string, script: string): void => {
  workspace.mkdir(`${directory}/objects`);
  workspace.mkdir(`${directory}/refs`);
  workspace.write(`${directory}/HEAD`, head);
  workspace.write(`${directory}/config`, fsmonitorConfig(script));
};

const SECRET = 'SECRET-CANARY-9';

const withRelocatableLink = (workspace: RealWorkspace): void => {
  workspace.link('../secret9', 'm/z');
  fs.writeFileSync(path.join(workspace.base, 'secret9'), `${SECRET}\n`);
  workspace.write('other/x', 'x\n');
  workspace.write('a', 'a\n');
};

describe('finding 1: an option value never hides a later option word', () => {
  it('git log --format --output=tracked truncates a tracked file and needs approval', () => {
    const workspace = makeRealWorkspace();
    workspace.initRepository();
    const command = 'git log --format --output=tracked -1';
    workspace.runBash(command);
    expect(workspace.read('tracked')).toBe('');
    expect(workspace.decide(command).kind).toBe('ask');
  });

  it('the same form truncates .git/info/exclude and needs approval', () => {
    const workspace = makeRealWorkspace();
    workspace.initRepository();
    expect(fs.statSync(path.join(workspace.project, '.git/info/exclude')).size).toBeGreaterThan(0);
    const command = 'git log --format --output=.git/info/exclude -1';
    workspace.runBash(command);
    expect(fs.statSync(path.join(workspace.project, '.git/info/exclude')).size).toBe(0);
    expect(workspace.decide(command).kind).toBe('ask');
  });

  it.each(['git log --format=%h -1', 'git log -n 1', 'git log --author t -1', 'git blame --reverse HEAD tracked'])('keeps allowing %s', (command) => {
    const workspace = makeRealWorkspace();
    workspace.initRepository();
    expect(workspace.decide(command).kind).toBe('allow');
  });
});

describe('finding 2: cd falls back to the physical path', () => {
  const layout = (workspace: RealWorkspace): ReturnType<typeof hookIn> => {
    const hook = hookIn(workspace);
    workspace.initRepository();
    bareLayout(workspace, 'bare', 'ref: refs/heads/main\n', hook.script);
    workspace.mkdir('bare/in');
    workspace.mkdir('bare/only');
    workspace.link('bare/in', 'pl');
    return hook;
  };

  it('cd pl/../only lands in the planted layout, runs its fsmonitor, and needs approval', () => {
    const workspace = makeRealWorkspace();
    const hook = layout(workspace);
    expect(workspace.runBash('cd pl/../only; pwd -P').stdout.trim()).toBe(path.join(workspace.project, 'bare', 'only'));
    workspace.runBash('cd pl/../only && git status');
    expect(hook.fired()).toBe(true);
    expect(workspace.decide('cd pl/../only && git status').kind).toBe('ask');
  });

  it('keeps allowing a logical target that exists', () => {
    const workspace = makeRealWorkspace();
    layout(workspace);
    workspace.mkdir('only');
    expect(workspace.decide('cd pl/../only && git status').kind).toBe('allow');
  });
});

describe('finding 3: a glob after a relocation is not judged against the old tree', () => {
  it('bash prints the secret through the moved link, and the glob needs approval', async () => {
    const workspace = makeRealWorkspace();
    withRelocatableLink(workspace);
    const command = 'mv m/z zz; cat zz*';
    const decision = await workspace.decideExpanding(command, { mode: 'acceptEdits' });
    expect(workspace.runBash(command).stdout).toBe(`${SECRET}\n`);
    expect(decision.kind).toBe('ask');
  });

  it('a character class has the same shape', async () => {
    const workspace = makeRealWorkspace();
    withRelocatableLink(workspace);
    expect((await workspace.decideExpanding('mv m/z zz; cat z[z]', { mode: 'acceptEdits' })).kind).toBe('ask');
  });

  it('a literal name is the anchor the glob must match', () => {
    const workspace = makeRealWorkspace();
    withRelocatableLink(workspace);
    expect(workspace.decide('mv m/z zz; cat zz', { mode: 'acceptEdits' }).kind).toBe('ask');
  });

  it('a glob in a directory nothing changed keeps being allowed', async () => {
    const workspace = makeRealWorkspace();
    withRelocatableLink(workspace);
    expect((await workspace.decideExpanding('mv m/z m/y; cat other/*', { mode: 'acceptEdits' })).kind).toBe('allow');
  });
});

describe('finding 4: concurrent segments see each other, independent of timing', () => {
  it('a FIFO holds the read back until after the move, so bash prints the secret, and approval is needed', () => {
    const workspace = makeRealWorkspace();
    withRelocatableLink(workspace);
    expect(spawnSync('/usr/bin/mkfifo', [path.join(workspace.project, 'ff')]).status).toBe(0);
    const command = 'cat ff zy & mv m/z zy; echo x > ff';
    const decision = workspace.decide(command, { mode: 'acceptEdits' });
    expect(workspace.runBash(command).stdout).toContain(SECRET);
    expect(decision.kind).toBe('ask');
  });

  it.each(['cat zy & mv m/z zy', 'cat zy | mv m/z zy', 'cat zy & echo a; mv m/z zy', 'cat zy | cat & mv m/z zy'])('%s needs approval', (command) => {
    const workspace = makeRealWorkspace();
    withRelocatableLink(workspace);
    expect(workspace.decide(command, { mode: 'acceptEdits' }).kind).toBe('ask');
  });

  it.each(['cat zy; mv m/z zy', 'cat zy && mv m/z zy', 'cat a | wc -l', 'cat a & mv m/z zy'])('keeps allowing %s', (command) => {
    const workspace = makeRealWorkspace();
    withRelocatableLink(workspace);
    expect(workspace.decide(command, { mode: 'acceptEdits' }).kind).toBe('allow');
  });
});

describe('finding 4 (second review): a background job inside a substitution outlives it', () => {
  it('a FIFO holds the job back until after the move, so out holds the secret, and approval is needed', () => {
    const workspace = makeRealWorkspace();
    withRelocatableLink(workspace);
    expect(spawnSync('/usr/bin/mkfifo', [path.join(workspace.project, 'ff')]).status).toBe(0);
    const command = 'echo $(cat ff zz > out &); mv m/z zz; echo x > ff';
    const decision = workspace.decide(command, { mode: 'acceptEdits' });
    workspace.runBash(command);
    for (let attempt = 0; attempt < 100 && !workspace.exists('out'); attempt += 1) spawnSync('/bin/sleep', ['0.05']);
    expect(workspace.read('out')).toContain(SECRET);
    expect(decision.kind).toBe('ask');
  });

  it.each([
    'echo $(cat zz > out &); mv m/z zz',
    'echo `cat zz > out &`; mv m/z zz',
    'echo $(cat zz > out & echo hi); mv m/z zz',
    'echo $(echo $(cat zz > out &)); mv m/z zz',
    'echo $(cat zz > out &) $(echo b); mv m/z zz',
    'echo $(cat zz | cat > out &); mv m/z zz',
  ])('%s needs approval', (command) => {
    const workspace = makeRealWorkspace();
    withRelocatableLink(workspace);
    expect(workspace.decide(command, { mode: 'acceptEdits' }).kind).toBe('ask');
  });

  it.each(['echo $(cat zz); mv m/z zz', 'echo $(cat zz > out); mv m/z zz', 'echo $(cat a > out &); mv m/z zz', 'echo $(cat zz > out &); echo done'])('keeps allowing %s', (command) => {
    const workspace = makeRealWorkspace();
    withRelocatableLink(workspace);
    expect(workspace.decide(command, { mode: 'acceptEdits' }).kind).toBe('allow');
  });
});

describe('finding 6 (second review): a populated submodule is judged like a discovered repository', () => {
  const withSubmodule = (workspace: RealWorkspace): ReturnType<typeof hookIn> => {
    const hook = hookIn(workspace);
    workspace.initRepository();
    workspace.initRepository('sm');
    workspace.git(path.join(workspace.project, 'sm'), 'config', 'core.fsmonitor', hook.script);
    const added = workspace.git(workspace.project, 'add', 'sm');
    if (added.status !== 0) throw new Error(`add failed: ${added.stderr}`);
    fs.writeFileSync(path.join(workspace.project, 'sm', 'extra'), '');
    return hook;
  };

  it.each(['git status', 'git diff', 'git status --ignore-submodules=untracked', 'git diff --ignore-submodules=untracked', 'git status --porcelain=v2', 'git diff --stat'])('%s runs the submodule fsmonitor in a plain environment and is approved because the read-only environment stops it', (command) => {
    const workspace = makeRealWorkspace();
    const hook = withSubmodule(workspace);
    workspace.runBash(command);
    expect(hook.fired()).toBe(true);
    expect(workspace.decide(command).kind).toBe('allow');
  });

  it.each(['git status --ignore-submodules=all', 'git status --ignore-submodules=dirty', 'git status --ignore-submodules', 'git diff --ignore-submodules=all', 'git diff --ignore-submodules=dirty', 'git log -1 -p', 'git ls-files -m', 'git rev-parse HEAD'])('%s does not reach the submodule and is allowed', (command) => {
    const workspace = makeRealWorkspace();
    const hook = withSubmodule(workspace);
    workspace.runBash(command);
    expect(hook.fired()).toBe(false);
    expect(workspace.decide(command).kind).toBe('allow');
  });

  it.each(['2', '3', '4'])('an index of version %s is read', (version) => {
    const workspace = makeRealWorkspace();
    const hook = withSubmodule(workspace);
    for (let index = 0; index < 5; index += 1) workspace.write(`dir${index}/file${index}`, 'x');
    workspace.git(workspace.project, 'add', '.');
    expect(workspace.git(workspace.project, 'update-index', '--index-version', version).status).toBe(0);
    workspace.runBash('git status');
    expect(hook.fired()).toBe(true);
    expect(workspace.decide('git status').kind).toBe('allow');
  });

  it('a repository without a submodule keeps being allowed', () => {
    const workspace = makeRealWorkspace();
    workspace.initRepository();
    expect(workspace.decide('git status').kind).toBe('allow');
    expect(workspace.decide('git diff').kind).toBe('allow');
  });

  it('a submodule nested in a submodule is approved too', () => {
    const workspace = makeRealWorkspace();
    const hook = hookIn(workspace);
    workspace.initRepository();
    workspace.initRepository('sm');
    workspace.initRepository('sm/inner');
    workspace.git(path.join(workspace.project, 'sm'), 'add', 'inner');
    workspace.git(path.join(workspace.project, 'sm'), 'commit', '-q', '-m', 'inner');
    workspace.git(path.join(workspace.project, 'sm', 'inner'), 'config', 'core.fsmonitor', hook.script);
    workspace.git(workspace.project, 'add', 'sm');
    workspace.runBash('git status');
    expect(workspace.decide('git status').kind).toBe('allow');
  });
});

describe('finding 5: --show-signature runs gpg from the search path', () => {
  const signed = (workspace: RealWorkspace): { hook: ReturnType<typeof hookIn>; searchPath: string; executionPath: string } => {
    const hook = hookIn(workspace);
    workspace.initRepository();
    signHead(workspace);
    const planted = workspace.mkdir('bin');
    fs.copyFileSync(hook.script, path.join(planted, 'gpg'));
    const systemTools = path.join(workspace.base, 'system-tools');
    fs.mkdirSync(systemTools);
    for (const program of ['git', 'touch']) fs.symlinkSync(`/usr/bin/${program}`, path.join(systemTools, program));
    return { hook, searchPath: `/usr/bin:/bin:${planted}`, executionPath: `${systemTools}:${planted}` };
  };

  const signedWithTag = (workspace: RealWorkspace): ReturnType<typeof signed> => {
    const setup = signed(workspace);
    const tagged = workspace.git(workspace.project, 'tag', '-a', '-m', 't', 'tg', 'HEAD');
    if (tagged.status !== 0) throw new Error(`tag failed: ${tagged.stderr}`);
    return setup;
  };

  it.each(['git log --show-signature -1', 'git show --show-signature -s', 'git log --format=%GG -1', 'git rev-list --format=%GG --max-count=1 HEAD', 'git for-each-ref --format="%(signature)"', 'git log --pretty=format:%+GG -1'])('%s runs the planted gpg and needs approval', (command) => {
    const workspace = makeRealWorkspace();
    const { hook, searchPath, executionPath } = signed(workspace);
    workspace.runBash(command, workspace.project, { PATH: executionPath });
    expect(hook.fired()).toBe(true);
    expect(workspace.decide(command, { searchPath }).kind).toBe('ask');
  });

  it.each([
    "git for-each-ref '--format=%(*signature)'",
    "git for-each-ref '--format=%(*signature:grade)'",
    "git tag -l '--format=%(*signature)'",
    'git for-each-ref --sort=signature',
    'git for-each-ref --sort=signature:grade',
    'git for-each-ref --sort=-signature',
    'git branch --sort=signature',
    'git branch --list --sort=signature',
    'git shortlog --group=format:%GG HEAD',
    "git shortlog '--group=format:%G?' HEAD",
    "git shortlog --group 'format:%GG' HEAD",
    "git for-each-ref --sort '*signature'",
  ])('%s runs the planted gpg and needs approval (ref-filter, sort key, shortlog group)', (command) => {
    const workspace = makeRealWorkspace();
    const { hook, searchPath, executionPath } = signedWithTag(workspace);
    workspace.runBash(command, workspace.project, { PATH: executionPath });
    expect(hook.fired()).toBe(true);
    expect(workspace.decide(command, { searchPath }).kind).toBe('ask');
  });

  it.each(["git for-each-ref '--sort=*signature'", "git tag -l '--sort=*signature'", "git branch '--sort=*signature'", "git for-each-ref '--sort=-*signature'", 'git for-each-ref \'--format=%(signature^{})\''])('%s needs approval whether or not this git runs the program', (command) => {
    const workspace = makeRealWorkspace();
    const { searchPath } = signedWithTag(workspace);
    expect(workspace.decide(command, { searchPath }).kind).toBe('ask');
  });

  it.each(['git for-each-ref --sort=refname', 'git for-each-ref --sort=-committerdate', "git for-each-ref '--format=%(refname) %(contents:signature)'", 'git branch --sort=refname', "git shortlog --group=format:%an HEAD", 'git shortlog --group=author HEAD'])('keeps allowing %s', (command) => {
    const workspace = makeRealWorkspace();
    const { hook, searchPath, executionPath } = signedWithTag(workspace);
    workspace.runBash(command, workspace.project, { PATH: executionPath });
    expect(hook.fired()).toBe(false);
    expect(workspace.decide(command, { searchPath }).kind).toBe('allow');
  });

  it('keeps allowing git log without the option', () => {
    const workspace = makeRealWorkspace();
    const { searchPath } = signed(workspace);
    expect(workspace.decide('git log -1', { searchPath }).kind).toBe('allow');
  });

  it('git rev-list --show-signature does not reach gpg and keeps being allowed', () => {
    const workspace = makeRealWorkspace();
    const { hook, searchPath, executionPath } = signed(workspace);
    const command = 'git rev-list --show-signature --format=%h --max-count=1 HEAD';
    workspace.runBash(command, workspace.project, { PATH: executionPath });
    expect(hook.fired()).toBe(false);
    expect(workspace.decide(command, { searchPath }).kind).toBe('allow');
  });
});

describe('finding 11: HEAD whitespace is git isspace, without vertical tab or form feed', () => {
  const nested = (workspace: RealWorkspace, head: string): { hook: ReturnType<typeof hookIn>; cwd: string } => {
    const hook = hookIn(workspace);
    workspace.initRepository();
    bareLayout(workspace, 'layout', head, hook.script);
    return { hook, cwd: workspace.mkdir('layout/sub') };
  };

  it.each([['vertical tab', 'ref:\vrefs/heads/main\n'], ['form feed', 'ref:\frefs/heads/main\n']])('git passes over a layout with %s, so no prompt is needed', (_name, head) => {
    const workspace = makeRealWorkspace();
    const { hook, cwd } = nested(workspace, head);
    expect(workspace.git(cwd, 'rev-parse', '--show-toplevel').stdout.trim()).toBe(workspace.project);
    workspace.git(cwd, 'status');
    expect(hook.fired()).toBe(false);
    expect(workspace.decide('git status', { cwd }).kind).toBe('allow');
  });

  it.each([['space', 'ref: refs/heads/main\n'], ['tab', 'ref:\trefs/heads/main\n'], ['carriage return', 'ref:\rrefs/heads/main\n']])('git accepts a layout with %s, so it keeps needing approval', (_name, head) => {
    const workspace = makeRealWorkspace();
    const { hook, cwd } = nested(workspace, head);
    workspace.git(cwd, 'status');
    expect(hook.fired()).toBe(true);
    expect(workspace.decide('git status', { cwd }).kind).toBe('ask');
  });

  it('a root .git directory with such a HEAD leaves the root itself as the bare layout git uses', () => {
    const workspace = makeRealWorkspace();
    const hook = hookIn(workspace);
    bareLayout(workspace, '.', 'ref: refs/heads/main\n', hook.script);
    bareLayout(workspace, '.git', 'ref:\vrefs/heads/main\n', hook.script);
    workspace.runBash('git status');
    expect(hook.fired()).toBe(true);
    expect(workspace.decide('git status').kind).toBe('ask');
  });
});
