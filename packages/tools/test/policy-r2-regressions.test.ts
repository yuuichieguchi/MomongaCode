import { describe, expect, it } from 'vitest';
import { makeDifferentialWorkspace } from './differential/fixture.ts';

const CAT = [['allow', 'Bash(cat:*)']] as const;

const expandedBy = (workspace: ReturnType<typeof makeDifferentialWorkspace>, word: string, cwd: string): string[] =>
  workspace.runBash(`shopt -s nullglob; printf '%s\\n' ${word}`, cwd).stdout.split('\n').filter((entry) => entry !== '');

describe('round 2, finding 1: a backtick substitution inside double quotes is read as bash reads it', () => {
  const attack = (name: string): string => `echo "\`echo \\"'\\"; touch ${name}; echo \\"'\\"\`"`;

  it('real bash runs the hidden command, so the policy has to see it', () => {
    const workspace = makeDifferentialWorkspace();
    workspace.runBash(attack('hidden1'));
    expect(workspace.exists('hidden1')).toBe(true);
  });

  it.each([[[]], [CAT]] as const)('asks, and asks to write the hidden file (rules %j)', (rules) => {
    const workspace = makeDifferentialWorkspace();
    const decision = workspace.decide(attack('hidden2'), { rules });
    expect(decision.kind).toBe('ask');
    expect(workspace.exists('hidden2')).toBe(false);
  });

  it('denies the hidden write under a deny rule', () => {
    const workspace = makeDifferentialWorkspace();
    expect(workspace.decide(attack('hidden3'), { rules: [['deny', 'Bash(touch:*)']] }).kind).toBe('deny');
  });
});

describe('round 2, finding 2: a dot-led glob reaches whatever the real bash makes it reach', () => {
  it('asks for .*/name when bash expands .* to ..', () => {
    const workspace = makeDifferentialWorkspace();
    const reaches = expandedBy(workspace, '.*', workspace.project).includes('..');
    const command = 'cat .*/CANARY-leak';
    expect(workspace.runBash(command).stdout.includes('CANARY') === reaches).toBe(true);
    expect(workspace.decide(command).kind).toBe(reaches ? 'ask' : 'allow');
    expect(workspace.decide(command, { rules: CAT }).kind).toBe(reaches ? 'ask' : 'allow');
  });

  it('asks for .?/.?/.?/name three levels up when bash lets .? match ..', () => {
    const workspace = makeDifferentialWorkspace();
    const cwd = `${workspace.project}/deep/x`;
    const reaches = expandedBy(workspace, '.?', cwd).includes('..');
    const command = 'cat .?/.?/.?/CANARY-top';
    expect(workspace.runBash(command, cwd).stdout.includes('CANARY')).toBe(reaches);
    expect(workspace.decide(command, { cwd }).kind).toBe(reaches ? 'ask' : 'allow');
  });

  it('asks for ls .* when bash expands it to ..', () => {
    const workspace = makeDifferentialWorkspace();
    const reaches = expandedBy(workspace, '.*', workspace.project).includes('..');
    expect(workspace.decide('ls .*').kind).toBe(reaches ? 'ask' : 'allow');
  });
});

describe('round 2, finding 3: quoted glob characters stay literal, classes and ranges are bash', () => {
  it.each([
    ['a POSIX class that finds the repository-shipped link', 'cat l[[:alpha:]]k'],
    ['a quoted bracket that matches a shipped link named [a]b', 'cat "[a]"*'],
    ['a backslash-escaped bracket', 'cat \\[a\\]*'],
    ['a single-quoted bracket', "cat '[a]'*"],
  ])('asks for %s, as bash reads the secret behind the link', (_label, command) => {
    const workspace = makeDifferentialWorkspace();
    expect(workspace.runBash(command).stdout).toContain('CANARY');
    expect(workspace.decide(command).kind).toBe('ask');
    expect(workspace.decide(command, { rules: CAT }).kind).toBe('ask');
  });

  it('does not throw for a range that is out of order and judges the word as bash does', () => {
    const workspace = makeDifferentialWorkspace();
    const command = 'cat [z-a]*';
    expect(workspace.runBash(command).status).not.toBe(0);
    expect(() => workspace.decide(command)).not.toThrow();
    expect(workspace.decide(command).kind).toBe('allow');
  });
});

describe('round 2, finding 4: a directory is a git directory exactly as git decides', () => {
  it.each([
    ['u40', 'HEAD of 40 uppercase hex digits'],
    ['g40', 'HEAD of 40 hex digits followed by garbage'],
    ['big', 'a ref HEAD padded past 64 KB'],
    ['xobj', 'objects and refs as executable regular files'],
  ])('real git runs the configuration in %s (%s), so decide asks', (name) => {
    const workspace = makeDifferentialWorkspace();
    const cwd = `${workspace.project}/${name}/sub`;
    workspace.git(cwd, 'status');
    expect(workspace.firedMarkers()).toContain(`fired-${name}`);
    expect(workspace.decide('git status', { cwd }).kind).toBe('ask');
  });

  it.each([
    ['a ref past the first 255 bytes', `ref:${' '.repeat(252)}refs/heads/main\n`],
    ['lower-case 39 hex digits', `${'a'.repeat(39)}\n`],
    ['ref: notrefs/x', 'ref: notrefs/x\n'],
  ])('real git skips a directory whose HEAD is %s, so decide allows', (_label, head) => {
    const workspace = makeDifferentialWorkspace();
    workspace.write('probe/HEAD', head);
    workspace.mkdir('probe/objects');
    workspace.mkdir('probe/refs');
    workspace.write('probe/config', `[core]\n\trepositoryformatversion = 0\n\tbare = false\n\tworktree = ..\n\tfsmonitor = ${workspace.hookScript('bare')}\n`);
    workspace.mkdir('probe/sub');
    const cwd = `${workspace.project}/probe/sub`;
    workspace.git(cwd, 'status');
    expect(workspace.firedMarkers()).toEqual([]);
    expect(workspace.decide('git status', { cwd }).kind).toBe('allow');
  });
});

describe('round 2, finding 5: cd -P and a cd through a link are resolved', () => {
  it('lands in the physical parent of the link target with cd -P', () => {
    const workspace = makeDifferentialWorkspace();
    workspace.runBash('cd -P pl/.. && git status');
    expect(workspace.firedMarkers()).toContain('fired-bare');
    expect(workspace.decide('cd -P pl/.. && git status').kind).toBe('ask');
    expect(workspace.decide('cd -P -- pl/.. && git status').kind).toBe('ask');
    expect(workspace.decide('cd -LP pl/.. && git status').kind).toBe('ask');
  });

  it('lands in the lexical parent with cd and cd -L, which is the workspace root', () => {
    const workspace = makeDifferentialWorkspace();
    expect(workspace.decide('cd pl/.. && git status').kind).toBe('allow');
    expect(workspace.decide('cd -L pl/.. && git status').kind).toBe('allow');
    expect(workspace.decide('cd -P -L pl/.. && git status').kind).toBe('allow');
  });

  it('reads -P after -- as the directory name', () => {
    const workspace = makeDifferentialWorkspace();
    workspace.mkdir('-P');
    expect(workspace.decide('cd -- -P && git status').kind).toBe('allow');
  });
});

describe('round 2, finding 6: a repository created earlier in the same command is modelled', () => {
  const create = (workspace: ReturnType<typeof makeDifferentialWorkspace>, directory: string): string =>
    [
      `mkdir -p ${directory}/objects ${directory}/refs`,
      `echo 'ref: refs/heads/main' > ${directory}/HEAD`,
      `echo '[core]' > ${directory}/config`,
      `echo 'repositoryformatversion = 0' >> ${directory}/config`,
      `echo 'bare = false' >> ${directory}/config`,
      `echo 'worktree = ..' >> ${directory}/config`,
      `echo 'fsmonitor = ${workspace.hookScript('bare')}' >> ${directory}/config`,
    ].join(' && ');

  it.each([
    ['cd into it', (directory: string) => `cd ${directory} && git status`],
    ['cd -P into it', (directory: string) => `cd -P ${directory} && git status`],
    ['--bare inside it', (directory: string) => `cd ${directory} && git --bare status`],
  ])('asks when the command %s', (_label, use) => {
    const workspace = makeDifferentialWorkspace();
    const command = `${create(workspace, 'made')} && ${use('made')}`;
    expect(workspace.decide(command, { mode: 'acceptEdits' }).kind).toBe('ask');
    workspace.runBash(command);
    expect(workspace.firedMarkers()).toContain('fired-bare');
  });

  it('asks for --bare at the root after the command wrote HEAD, objects and refs there', () => {
    const workspace = makeDifferentialWorkspace();
    const command = `${create(workspace, '.')} && git --bare status`;
    expect(workspace.decide(command, { mode: 'acceptEdits' }).kind).toBe('ask');
  });

  it('still approves git after writes that do not touch the search', () => {
    const workspace = makeDifferentialWorkspace();
    expect(workspace.decide('mkdir -p out/deep && echo x > out/deep/f && git status', { mode: 'acceptEdits' }).kind).toBe('allow');
  });
});

describe('round 2, finding 7: git reflog is approved by an allowlist of read forms', () => {
  const written = 'git reflog write HEAD $(git rev-parse HEAD) $(git rev-parse HEAD) evil';

  it('real git writes the reflog entry, so the form is not read-only', () => {
    const workspace = makeDifferentialWorkspace();
    const before = workspace.git(workspace.project, 'reflog').stdout;
    workspace.runBash(written);
    expect(workspace.git(workspace.project, 'reflog').stdout).not.toBe(before);
  });

  it.each([written, 'git reflog write', 'git reflog HEAD', 'git reflog main', 'git reflog expire --all', 'git reflog some-future-subcommand'])('asks for %s', (command) => {
    const workspace = makeDifferentialWorkspace();
    expect(workspace.decide(command).kind).toBe('ask');
    expect(workspace.decide(command, { mode: 'plan' }).kind).toBe('ask');
  });

  it.each(['git reflog', 'git reflog show', 'git reflog show HEAD', 'git reflog list', 'git reflog exists HEAD', 'git reflog -n 1', 'git reflog --oneline'])('allows %s', (command) => {
    const workspace = makeDifferentialWorkspace();
    expect(workspace.decide(command).kind).toBe('allow');
    expect(workspace.runBash(command).status).toBe(0);
  });
});
