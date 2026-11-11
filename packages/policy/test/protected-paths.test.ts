import { testSecretLocations } from '@momonga/testkit';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { decide } from '@momonga/policy';
import type { DecideInput, PermissionSubject, PolicyTool } from '@momonga/policy';
import type { PermissionMode } from '@momonga/protocol';
import { TEST_SEARCH_PATH, fakeFs, fileRulesFor, isWritableFor, makeLayout, protectedSetWith, ruleIn, touch } from './helpers.ts';
import type { Layout } from './helpers.ts';

const READ: PolicyTool = { name: 'Read', kind: 'read', sideEffect: 'read_only' };
const WRITE: PolicyTool = { name: 'Write', kind: 'edit', sideEffect: 'write', subjectKind: 'path' };
const EDIT: PolicyTool = { name: 'Edit', kind: 'edit', sideEffect: 'write', subjectKind: 'path' };
const BASH: PolicyTool = { name: 'Bash', kind: 'execute', sideEffect: 'exec', subjectKind: 'command' };

const setup = () => {
  const layout = makeLayout();
  const gitDir = path.join(layout.project, '.git');
  const settingsFile = touch(path.join(layout.project, '.momonga', 'settings.json'));
  touch(path.join(gitDir, 'config'));
  return { layout, gitDir, settingsFile };
};

const input = async (layout: Layout, tool: PolicyTool, subject: PermissionSubject, mode: PermissionMode, protectedPaths: readonly string[], extra: Partial<DecideInput> = {}): Promise<DecideInput> => {
  const given = {
    tool,
    subject,
    mode,
    rules: [],
    roots: [layout.project],
    home: layout.home,
    secretLocations: testSecretLocations(layout.home),
    cwd: layout.project,
    fs: fakeFs(), searchPath: TEST_SEARCH_PATH, isWritable: isWritableFor([layout.project]),
    protectedSet: protectedSetWith([layout.project], protectedPaths),
    ...extra,
  };
  return { fileRules: await fileRulesFor(given.rules, given.roots), ...given };
};

const writeSubject = (tool: string, target: string): PermissionSubject => ({ kind: 'path', tool, paths: [target], access: 'write' });

describe('protected paths', () => {
  it.each(['manual', 'acceptEdits', 'bypassPermissions'] as const)('asks before writing inside a protected directory in %s mode', async (mode) => {
    const { layout, gitDir } = setup();
    const target = path.join(gitDir, 'config');
    const decision = await decide(await input(layout, WRITE, writeSubject('Write', target), mode, [gitDir]));
    expect(decision.kind).toBe('ask');
    expect(decision.source).toBe('protected');
    expect(decision.reason).toContain(gitDir);
  });

  it.each(['manual', 'acceptEdits', 'bypassPermissions'] as const)('asks before editing a protected file itself in %s mode', async (mode) => {
    const { layout, settingsFile } = setup();
    const decision = await decide(await input(layout, EDIT, writeSubject('Edit', settingsFile), mode, [settingsFile]));
    expect(decision).toMatchObject({ kind: 'ask', source: 'protected' });
    expect(decision.reason).toContain(settingsFile);
  });

  it('asks for a new file that does not exist yet inside a protected directory', async () => {
    const { layout, gitDir } = setup();
    const decision = await decide(await input(layout, WRITE, writeSubject('Write', path.join(gitDir, 'hooks', 'pre-commit')), 'bypassPermissions', [gitDir]));
    expect(decision).toMatchObject({ kind: 'ask', source: 'protected' });
  });

  it('asks when any of several paths is protected', async () => {
    const { layout, gitDir } = setup();
    const subject: PermissionSubject = { kind: 'path', tool: 'Edit', paths: [path.join(layout.project, 'a.txt'), path.join(gitDir, 'config')], access: 'write' };
    expect(await decide(await input(layout, EDIT, subject, 'acceptEdits', [gitDir]))).toMatchObject({ kind: 'ask', source: 'protected' });
  });

  it('does not treat a sibling sharing the name prefix as protected', async () => {
    const { layout, gitDir } = setup();
    const sibling = touch(path.join(layout.project, '.gitignore'));
    const decision = await decide(await input(layout, WRITE, writeSubject('Write', sibling), 'acceptEdits', [gitDir]));
    expect(decision).toMatchObject({ kind: 'allow', source: 'mode' });
  });

  it('lets deny rules win over the protected ask', async () => {
    const { layout, gitDir } = setup();
    const rules = [ruleIn(layout)('deny', 'Write')];
    const decision = await decide(await input(layout, WRITE, writeSubject('Write', path.join(gitDir, 'config')), 'bypassPermissions', [gitDir], { rules }));
    expect(decision).toMatchObject({ kind: 'deny', source: 'rule' });
  });

  it('keeps plan mode denying non-read-only tools', async () => {
    const { layout, gitDir } = setup();
    const decision = await decide(await input(layout, WRITE, writeSubject('Write', path.join(gitDir, 'config')), 'plan', [gitDir]));
    expect(decision).toMatchObject({ kind: 'deny', source: 'mode' });
  });

  it('does not let allow rules override the protected ask', async () => {
    const { layout, gitDir } = setup();
    const rules = [ruleIn(layout)('allow', 'Write'), ruleIn(layout)('allow', `Write(/${gitDir}/**)`)];
    const decision = await decide(await input(layout, WRITE, writeSubject('Write', path.join(gitDir, 'config')), 'manual', [gitDir], { rules }));
    expect(decision).toMatchObject({ kind: 'ask', source: 'protected' });
  });

  it('leaves reads of protected paths unaffected', async () => {
    const { layout, gitDir } = setup();
    const subject: PermissionSubject = { kind: 'path', tool: 'Read', paths: [path.join(gitDir, 'config')], access: 'read' };
    expect(await decide(await input(layout, READ, subject, 'manual', [gitDir]))).toMatchObject({ kind: 'allow', source: 'mode' });
  });

  it('behaves as before when no protected paths are given', async () => {
    const { layout, gitDir } = setup();
    expect(await decide(await input(layout, WRITE, writeSubject('Write', path.join(gitDir, 'config')), 'bypassPermissions', []))).toMatchObject({ kind: 'allow' });
  });

  it('canonicalizes a write through a symlink into a protected directory', async () => {
    const { layout, gitDir } = setup();
    const link = path.join(layout.project, 'link');
    fs.symlinkSync(gitDir, link);
    const decision = await decide(await input(layout, WRITE, writeSubject('Write', path.join(link, 'config')), 'bypassPermissions', [gitDir]));
    expect(decision).toMatchObject({ kind: 'ask', source: 'protected' });
  });

  it('canonicalizes a protected path given through a symlink', async () => {
    const { layout, gitDir } = setup();
    const link = path.join(layout.project, 'link');
    fs.symlinkSync(gitDir, link);
    const decision = await decide(await input(layout, WRITE, writeSubject('Write', path.join(gitDir, 'config')), 'bypassPermissions', [link]));
    expect(decision).toMatchObject({ kind: 'ask', source: 'protected' });
  });

  it('canonicalizes dot segments in the target', async () => {
    const { layout, gitDir } = setup();
    const decision = await decide(await input(layout, WRITE, writeSubject('Write', path.join(layout.project, 'src', '..', '.git', 'config')), 'bypassPermissions', [gitDir]));
    expect(decision).toMatchObject({ kind: 'ask', source: 'protected' });
  });

  it.each([
    ['an absolute redirect', (gitDir: string) => `echo x > ${gitDir}/config`],
    ['an append redirect', (gitDir: string) => `echo x >> ${gitDir}/config`],
    ['a relative redirect', () => 'echo x > .git/config'],
    ['a tee writer', (gitDir: string) => `echo x | tee ${gitDir}/hooks/pre-commit`],
  ])('asks for Bash writing into a protected path through %s', async (_label, command) => {
    const { layout, gitDir } = setup();
    const subject: PermissionSubject = { kind: 'command', tool: 'Bash', command: command(gitDir) };
    const decision = await decide(await input(layout, BASH, subject, 'bypassPermissions', [gitDir]));
    expect(decision).toMatchObject({ kind: 'ask', source: 'protected' });
  });

  it('resolves relative Bash redirects against a cwd inside the protected directory', async () => {
    const { layout, gitDir } = setup();
    const subject: PermissionSubject = { kind: 'command', tool: 'Bash', command: 'echo x > config' };
    expect(await decide(await input(layout, BASH, subject, 'bypassPermissions', [gitDir], { cwd: gitDir }))).toMatchObject({ kind: 'ask', source: 'protected' });
  });

  it('does not ask for Bash commands that only read protected paths', async () => {
    const { layout, gitDir } = setup();
    const subject: PermissionSubject = { kind: 'command', tool: 'Bash', command: `cat < ${gitDir}/config` };
    expect(await decide(await input(layout, BASH, subject, 'bypassPermissions', [gitDir]))).toMatchObject({ kind: 'allow' });
  });

  describe('targets that cannot be canonicalized', () => {
    const dangling = (layout: Layout, gitDir: string): string => {
      const evil = path.join(layout.project, 'evil');
      fs.symlinkSync(path.join(gitDir, 'hooks', 'pre-commit'), evil);
      return evil;
    };

    it.each(['manual', 'acceptEdits', 'bypassPermissions'] as const)('asks for a dangling symlink into a protected directory in %s mode', async (mode) => {
      const { layout, gitDir } = setup();
      const evil = dangling(layout, gitDir);
      expect(await decide(await input(layout, WRITE, writeSubject('Write', evil), mode, [gitDir]))).toMatchObject({ kind: 'ask', source: 'protected' });
      expect(await decide(await input(layout, EDIT, writeSubject('Edit', evil), mode, [gitDir]))).toMatchObject({ kind: 'ask', source: 'protected' });
    });

    it('asks for a dangling symlink even with an allow rule covering it', async () => {
      const { layout, gitDir } = setup();
      const evil = dangling(layout, gitDir);
      const rules = [ruleIn(layout)('allow', 'Write'), ruleIn(layout)('allow', `Write(/${evil})`)];
      expect(await decide(await input(layout, WRITE, writeSubject('Write', evil), 'bypassPermissions', [gitDir], { rules }))).toMatchObject({ kind: 'ask', source: 'protected' });
    });

    it('asks for a Bash redirect through a dangling symlink', async () => {
      const { layout, gitDir } = setup();
      dangling(layout, gitDir);
      const subject: PermissionSubject = { kind: 'command', tool: 'Bash', command: 'echo x > evil' };
      expect(await decide(await input(layout, BASH, subject, 'bypassPermissions', [gitDir]))).toMatchObject({ kind: 'ask', source: 'protected' });
    });

    const danglingOutside = (layout: Layout): { link: string; target: string } => {
      const link = path.join(layout.project, 'elsewhere');
      const target = path.join(layout.outside, 'nothing', 'here.txt');
      fs.symlinkSync(target, link);
      return { link, target };
    };

    const verdict = (decision: { kind: string; source?: string }) => ({ kind: decision.kind, source: decision.source });

    it('decides a dangling symlink outside protected paths like a direct write to its target in bypassPermissions', async () => {
      const { layout, gitDir } = setup();
      const { link, target } = danglingOutside(layout);
      const viaLink = await decide(await input(layout, WRITE, writeSubject('Write', link), 'bypassPermissions', [gitDir]));
      const direct = await decide(await input(layout, WRITE, writeSubject('Write', target), 'bypassPermissions', [gitDir]));
      expect(verdict(viaLink)).toEqual(verdict(direct));
      expect(viaLink.source).not.toBe('protected');
    });

    it('asks for a dangling symlink whose target is outside the roots in manual mode', async () => {
      const { layout, gitDir } = setup();
      const { link, target } = danglingOutside(layout);
      const viaLink = await decide(await input(layout, WRITE, writeSubject('Write', link), 'manual', [gitDir]));
      expect(viaLink.kind).toBe('ask');
      expect(verdict(viaLink)).toEqual(verdict(await decide(await input(layout, WRITE, writeSubject('Write', target), 'manual', [gitDir]))));
    });

    it('fails closed for a symlink loop', async () => {
      const { layout, gitDir } = setup();
      const a = path.join(layout.project, 'a');
      const b = path.join(layout.project, 'b');
      fs.symlinkSync(b, a);
      fs.symlinkSync(a, b);
      expect(await decide(await input(layout, WRITE, writeSubject('Write', a), 'bypassPermissions', [gitDir]))).toMatchObject({ kind: 'ask', source: 'protected' });
    });

    it('lets deny rules win over the fail-closed ask', async () => {
      const { layout, gitDir } = setup();
      const evil = dangling(layout, gitDir);
      const rules = [ruleIn(layout)('deny', 'Write')];
      expect(await decide(await input(layout, WRITE, writeSubject('Write', evil), 'bypassPermissions', [gitDir], { rules }))).toMatchObject({ kind: 'deny', source: 'rule' });
    });

    it('keeps plan mode denying', async () => {
      const { layout, gitDir } = setup();
      const evil = dangling(layout, gitDir);
      expect(await decide(await input(layout, WRITE, writeSubject('Write', evil), 'plan', [gitDir]))).toMatchObject({ kind: 'deny', source: 'mode' });
    });

    it('does not force an ask for a plain new file in a normal directory', async () => {
      const { layout, gitDir } = setup();
      const fresh = path.join(layout.project, 'src', 'new-file.ts');
      expect(await decide(await input(layout, WRITE, writeSubject('Write', fresh), 'acceptEdits', [gitDir]))).toMatchObject({ kind: 'allow', source: 'mode' });
    });
  });
});

