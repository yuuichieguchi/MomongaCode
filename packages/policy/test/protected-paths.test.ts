import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { decide } from '@momonga/policy';
import type { DecideInput, PermissionSubject, PolicyTool } from '@momonga/policy';
import type { PermissionMode } from '@momonga/protocol';
import { makeLayout, ruleIn, touch } from './helpers.ts';
import type { Layout } from './helpers.ts';

const READ: PolicyTool = { name: 'Read', kind: 'read', sideEffect: 'read_only' };
const WRITE: PolicyTool = { name: 'Write', kind: 'edit', sideEffect: 'write' };
const EDIT: PolicyTool = { name: 'Edit', kind: 'edit', sideEffect: 'write' };
const BASH: PolicyTool = { name: 'Bash', kind: 'execute', sideEffect: 'exec' };

const setup = () => {
  const layout = makeLayout();
  const gitDir = path.join(layout.project, '.git');
  const settingsFile = touch(path.join(layout.project, '.momonga', 'settings.json'));
  touch(path.join(gitDir, 'config'));
  return { layout, gitDir, settingsFile };
};

const input = (layout: Layout, tool: PolicyTool, subject: PermissionSubject, mode: PermissionMode, protectedPaths: readonly string[], extra: Partial<DecideInput> = {}): DecideInput => ({
  tool,
  subject,
  mode,
  rules: [],
  roots: [layout.project],
  home: layout.home,
  cwd: layout.project,
  protectedPaths,
  ...extra,
});

const writeSubject = (tool: string, target: string): PermissionSubject => ({ kind: 'path', tool, paths: [target], access: 'write' });

describe('protected paths', () => {
  it.each(['default', 'acceptEdits', 'bypassPermissions'] as const)('asks before writing inside a protected directory in %s mode', (mode) => {
    const { layout, gitDir } = setup();
    const target = path.join(gitDir, 'config');
    const decision = decide(input(layout, WRITE, writeSubject('Write', target), mode, [gitDir]));
    expect(decision.kind).toBe('ask');
    expect(decision.source).toBe('protected');
    expect(decision.reason).toContain(gitDir);
  });

  it.each(['default', 'acceptEdits', 'bypassPermissions'] as const)('asks before editing a protected file itself in %s mode', (mode) => {
    const { layout, settingsFile } = setup();
    const decision = decide(input(layout, EDIT, writeSubject('Edit', settingsFile), mode, [settingsFile]));
    expect(decision).toMatchObject({ kind: 'ask', source: 'protected' });
    expect(decision.reason).toContain(settingsFile);
  });

  it('asks for a new file that does not exist yet inside a protected directory', () => {
    const { layout, gitDir } = setup();
    const decision = decide(input(layout, WRITE, writeSubject('Write', path.join(gitDir, 'hooks', 'pre-commit')), 'bypassPermissions', [gitDir]));
    expect(decision).toMatchObject({ kind: 'ask', source: 'protected' });
  });

  it('asks when any of several paths is protected', () => {
    const { layout, gitDir } = setup();
    const subject: PermissionSubject = { kind: 'path', tool: 'Edit', paths: [path.join(layout.project, 'a.txt'), path.join(gitDir, 'config')], access: 'write' };
    expect(decide(input(layout, EDIT, subject, 'acceptEdits', [gitDir]))).toMatchObject({ kind: 'ask', source: 'protected' });
  });

  it('does not treat a sibling sharing the name prefix as protected', () => {
    const { layout, gitDir } = setup();
    const sibling = touch(path.join(layout.project, '.gitignore'));
    const decision = decide(input(layout, WRITE, writeSubject('Write', sibling), 'acceptEdits', [gitDir]));
    expect(decision).toMatchObject({ kind: 'allow', source: 'mode' });
  });

  it('lets deny rules win over the protected ask', () => {
    const { layout, gitDir } = setup();
    const rules = [ruleIn(layout)('deny', 'Write')];
    const decision = decide(input(layout, WRITE, writeSubject('Write', path.join(gitDir, 'config')), 'bypassPermissions', [gitDir], { rules }));
    expect(decision).toMatchObject({ kind: 'deny', source: 'rule' });
  });

  it('keeps plan mode denying non-read-only tools', () => {
    const { layout, gitDir } = setup();
    const decision = decide(input(layout, WRITE, writeSubject('Write', path.join(gitDir, 'config')), 'plan', [gitDir]));
    expect(decision).toMatchObject({ kind: 'deny', source: 'mode' });
  });

  it('does not let allow rules override the protected ask', () => {
    const { layout, gitDir } = setup();
    const rules = [ruleIn(layout)('allow', 'Write'), ruleIn(layout)('allow', `Write(/${gitDir}/**)`)];
    const decision = decide(input(layout, WRITE, writeSubject('Write', path.join(gitDir, 'config')), 'default', [gitDir], { rules }));
    expect(decision).toMatchObject({ kind: 'ask', source: 'protected' });
  });

  it('leaves reads of protected paths unaffected', () => {
    const { layout, gitDir } = setup();
    const subject: PermissionSubject = { kind: 'path', tool: 'Read', paths: [path.join(gitDir, 'config')], access: 'read' };
    expect(decide(input(layout, READ, subject, 'default', [gitDir]))).toMatchObject({ kind: 'allow', source: 'mode' });
  });

  it('behaves as before when no protected paths are given', () => {
    const { layout, gitDir } = setup();
    expect(decide(input(layout, WRITE, writeSubject('Write', path.join(gitDir, 'config')), 'bypassPermissions', []))).toMatchObject({ kind: 'allow' });
  });

  it('canonicalizes a write through a symlink into a protected directory', () => {
    const { layout, gitDir } = setup();
    const link = path.join(layout.project, 'link');
    fs.symlinkSync(gitDir, link);
    const decision = decide(input(layout, WRITE, writeSubject('Write', path.join(link, 'config')), 'bypassPermissions', [gitDir]));
    expect(decision).toMatchObject({ kind: 'ask', source: 'protected' });
  });

  it('canonicalizes a protected path given through a symlink', () => {
    const { layout, gitDir } = setup();
    const link = path.join(layout.project, 'link');
    fs.symlinkSync(gitDir, link);
    const decision = decide(input(layout, WRITE, writeSubject('Write', path.join(gitDir, 'config')), 'bypassPermissions', [link]));
    expect(decision).toMatchObject({ kind: 'ask', source: 'protected' });
  });

  it('canonicalizes dot segments in the target', () => {
    const { layout, gitDir } = setup();
    const decision = decide(input(layout, WRITE, writeSubject('Write', path.join(layout.project, 'src', '..', '.git', 'config')), 'bypassPermissions', [gitDir]));
    expect(decision).toMatchObject({ kind: 'ask', source: 'protected' });
  });

  it.each([
    ['an absolute redirect', (gitDir: string) => `echo x > ${gitDir}/config`],
    ['an append redirect', (gitDir: string) => `echo x >> ${gitDir}/config`],
    ['a relative redirect', () => 'echo x > .git/config'],
    ['a tee writer', (gitDir: string) => `echo x | tee ${gitDir}/hooks/pre-commit`],
  ])('asks for Bash writing into a protected path through %s', (_label, command) => {
    const { layout, gitDir } = setup();
    const subject: PermissionSubject = { kind: 'command', tool: 'Bash', command: command(gitDir) };
    const decision = decide(input(layout, BASH, subject, 'bypassPermissions', [gitDir]));
    expect(decision).toMatchObject({ kind: 'ask', source: 'protected' });
  });

  it('resolves relative Bash redirects against a cwd inside the protected directory', () => {
    const { layout, gitDir } = setup();
    const subject: PermissionSubject = { kind: 'command', tool: 'Bash', command: 'echo x > config' };
    expect(decide(input(layout, BASH, subject, 'bypassPermissions', [gitDir], { cwd: gitDir }))).toMatchObject({ kind: 'ask', source: 'protected' });
  });

  it('does not ask for Bash commands that only read protected paths', () => {
    const { layout, gitDir } = setup();
    const subject: PermissionSubject = { kind: 'command', tool: 'Bash', command: `cat < ${gitDir}/config` };
    expect(decide(input(layout, BASH, subject, 'bypassPermissions', [gitDir]))).toMatchObject({ kind: 'allow' });
  });

  describe('targets that cannot be canonicalized', () => {
    const dangling = (layout: Layout, gitDir: string): string => {
      const evil = path.join(layout.project, 'evil');
      fs.symlinkSync(path.join(gitDir, 'hooks', 'pre-commit'), evil);
      return evil;
    };

    it.each(['default', 'acceptEdits', 'bypassPermissions'] as const)('asks for a dangling symlink into a protected directory in %s mode', (mode) => {
      const { layout, gitDir } = setup();
      const evil = dangling(layout, gitDir);
      expect(decide(input(layout, WRITE, writeSubject('Write', evil), mode, [gitDir]))).toMatchObject({ kind: 'ask', source: 'protected' });
      expect(decide(input(layout, EDIT, writeSubject('Edit', evil), mode, [gitDir]))).toMatchObject({ kind: 'ask', source: 'protected' });
    });

    it('asks for a dangling symlink even with an allow rule covering it', () => {
      const { layout, gitDir } = setup();
      const evil = dangling(layout, gitDir);
      const rules = [ruleIn(layout)('allow', 'Write'), ruleIn(layout)('allow', `Write(/${evil})`)];
      expect(decide(input(layout, WRITE, writeSubject('Write', evil), 'bypassPermissions', [gitDir], { rules }))).toMatchObject({ kind: 'ask', source: 'protected' });
    });

    it('asks for a Bash redirect through a dangling symlink', () => {
      const { layout, gitDir } = setup();
      dangling(layout, gitDir);
      const subject: PermissionSubject = { kind: 'command', tool: 'Bash', command: 'echo x > evil' };
      expect(decide(input(layout, BASH, subject, 'bypassPermissions', [gitDir]))).toMatchObject({ kind: 'ask', source: 'protected' });
    });

    it('fails closed for a dangling symlink whose target is outside protected paths', () => {
      const { layout, gitDir } = setup();
      const link = path.join(layout.project, 'elsewhere');
      fs.symlinkSync(path.join(layout.outside, 'nothing', 'here.txt'), link);
      expect(decide(input(layout, WRITE, writeSubject('Write', link), 'bypassPermissions', [gitDir]))).toMatchObject({ kind: 'ask', source: 'protected' });
    });

    it('lets deny rules win over the fail-closed ask', () => {
      const { layout, gitDir } = setup();
      const evil = dangling(layout, gitDir);
      const rules = [ruleIn(layout)('deny', 'Write')];
      expect(decide(input(layout, WRITE, writeSubject('Write', evil), 'bypassPermissions', [gitDir], { rules }))).toMatchObject({ kind: 'deny', source: 'rule' });
    });

    it('keeps plan mode denying', () => {
      const { layout, gitDir } = setup();
      const evil = dangling(layout, gitDir);
      expect(decide(input(layout, WRITE, writeSubject('Write', evil), 'plan', [gitDir]))).toMatchObject({ kind: 'deny', source: 'mode' });
    });

    it('does not force an ask for a plain new file in a normal directory', () => {
      const { layout, gitDir } = setup();
      const fresh = path.join(layout.project, 'src', 'new-file.ts');
      expect(decide(input(layout, WRITE, writeSubject('Write', fresh), 'acceptEdits', [gitDir]))).toMatchObject({ kind: 'allow', source: 'mode' });
    });
  });
});

