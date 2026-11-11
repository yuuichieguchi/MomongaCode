import { describe, expect, it } from 'vitest';
import { decide } from '@momonga/policy';
import type { Decision, PolicyTool } from '@momonga/policy';
import { EMPTY_PROTECTED_SET } from '@momonga/foundation';
import { TEST_SEARCH_PATH, fakeFs, fileRulesFor, isWritableFor, makeLayout, ruleIn } from './helpers.ts';

const BASH: PolicyTool = { name: 'Bash', kind: 'execute', sideEffect: 'exec', subjectKind: 'command' };

type Spec = { allow?: string[]; ask?: string[]; deny?: string[] };

const bash = async (command: string, spec: Spec): Promise<Decision> => {
  const layout = makeLayout();
  const make = ruleIn(layout);
  const rules = [...(spec.allow ?? []).map((text) => make('allow', text)), ...(spec.ask ?? []).map((text) => make('ask', text)), ...(spec.deny ?? []).map((text) => make('deny', text))];
  return decide({
    tool: BASH,
    subject: { kind: 'command', tool: 'Bash', command },
    mode: 'manual',
    rules,
    roots: [layout.project],
    home: layout.home,
    cwd: layout.project,
    fs: fakeFs(),
    searchPath: TEST_SEARCH_PATH,
    isWritable: isWritableFor([layout.project]),
    protectedSet: EMPTY_PROTECTED_SET,
    fileRules: await fileRulesFor(rules, [layout.project]),
  });
};

const GIT = { allow: ['Bash(git:*)'], deny: ['Bash(git push:*)'] };

describe('a Bash deny pattern is compared after the declared options of the program are removed', () => {
  it.each(['git --no-pager push', 'git -C . push', 'git -c k=v push', 'git -C . --no-pager -c k=v push origin main', '/usr/bin/git --no-pager push'])('%s is denied by Bash(git push:*)', async (command) => {
    const decision = await bash(command, GIT);

    expect(decision).toMatchObject({ kind: 'deny', source: 'rule' });
    expect(decision.rule?.text).toBe('Bash(git push:*)');
  });

  it.each(['git -C push status', 'git --no-pager status', 'git -c k=push log'])('%s is not denied by Bash(git push:*): the word is the value of an option or absent', async (command) => {
    expect((await bash(command, GIT)).kind).not.toBe('deny');
  });

  it('removes the options of the subcommand too, declared or not, before the next pattern word', async () => {
    const rules = { allow: ['Bash(git:*)'], deny: ['Bash(git push --force:*)'] };

    expect((await bash('git push -q --force origin', rules)).kind).toBe('deny');
    expect((await bash('git --no-pager push --no-verify --force', rules)).kind).toBe('deny');
    expect((await bash('git push origin main', rules)).kind).not.toBe('deny');
  });

  it('matches an exact pattern when only declared options stand between its words', async () => {
    const rules = { allow: ['Bash(git:*)'], deny: ['Bash(git push)'] };

    expect((await bash('git --no-pager push', rules)).kind).toBe('deny');
    expect((await bash('git --no-pager push origin', rules)).kind).not.toBe('deny');
  });

  it('gives an ask rule the same comparison', async () => {
    const decision = await bash('git --no-pager push', { allow: ['Bash(git:*)'], ask: ['Bash(git push:*)'] });

    expect(decision).toMatchObject({ kind: 'ask', source: 'rule' });
  });

  it('compares a program that has no option table by adjacent words', async () => {
    const rules = { allow: ['Bash(frobnicate:*)'], deny: ['Bash(frobnicate push:*)'] };

    expect((await bash('frobnicate push', rules)).kind).toBe('deny');
    expect((await bash('frobnicate --quiet push', rules)).kind).not.toBe('deny');
  });
});
