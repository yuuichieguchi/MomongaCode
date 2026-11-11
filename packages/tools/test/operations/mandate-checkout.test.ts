import { testSecretLocations } from '@momonga/testkit';
import { describe, expect, it } from 'vitest';
import { EMPTY_PROTECTED_SET } from '@momonga/foundation';
import { decide } from '@momonga/policy';
import type { DecideInput, Decision } from '@momonga/policy';
import { COVERED_PROGRAMS, OPERATION_SPECS, createBuiltinTools, operationCatalogueFacts, supersededForms } from '@momonga/tools';
import { TEST_SEARCH_PATH, fakeFs, fileRulesFor, isWritableFor, makeLayout, ruleIn } from '../../../policy/test/helpers.ts';

const FORMS = supersededForms(OPERATION_SPECS);

const decideBash = async (command: string, mandate: boolean): Promise<Decision> => {
  const layout = makeLayout();
  const roots = [layout.project];
  const rules = [ruleIn(layout)('allow', 'Bash(git:*)')];
  return decide({
    tool: { name: 'Bash', kind: 'execute', sideEffect: 'exec', subjectKind: 'command' },
    subject: { kind: 'command', tool: 'Bash', command },
    mode: 'manual',
    rules,
    roots,
    home: layout.home,
    secretLocations: testSecretLocations(layout.home),
    cwd: layout.project,
    fileRules: await fileRulesFor(rules, roots),
    protectedSet: EMPTY_PROTECTED_SET,
    fs: fakeFs(),
    searchPath: TEST_SEARCH_PATH,
    isWritable: isWritableFor(roots),
    ...(mandate ? { mandate: true as const, supersededForms: FORMS, coveredPrograms: COVERED_PROGRAMS } : {}),
  } as DecideInput);
};

describe('git checkout in a run under a mandate', () => {
  it.each(['git checkout -b x', 'git checkout main', 'git -C sub checkout -q main', 'git checkout -B x origin/main'])('refuses %s and names GitBranch, which replaces it', async (command) => {
    const decision = await decideBash(command, true);
    expect(decision).toMatchObject({ kind: 'deny', denial: 'superseded' });
    expect((decision as { reason: string }).reason).toBe('Not run: this run has a mandate, and git checkout is replaced by a dedicated operation; use GitBranch');
  });

  it.each(['git checkout -- file', 'git checkout HEAD~1 -- src/a.ts src/b.ts', 'git checkout -q -- .', 'git -C sub checkout -- file'])('refuses %s because it discards work, and does not send the model to GitBranch', async (command) => {
    const decision = await decideBash(command, true);
    expect(decision).toMatchObject({ kind: 'deny', denial: 'superseded' });
    const { reason } = decision as { reason: string };
    expect(reason).toBe(
      'Not run: this run has a mandate, and git checkout -- is refused: it overwrites files of the working tree with the content of the index or of a commit, which discards changes that no commit holds',
    );
    expect(reason).not.toContain('GitBranch');
  });

  it('does not take the words after -- of another git command for the refused form', async () => {
    const decision = await decideBash('git add -- checkout', true);
    expect(decision).toMatchObject({ kind: 'deny', denial: 'superseded' });
    expect((decision as { reason: string }).reason).toContain('use GitStage');
  });

  it('leaves git checkout to the rules of the person in a run without a mandate', async () => {
    expect((await decideBash('git checkout -- file', false)) as { denial?: string }).not.toMatchObject({ denial: 'superseded' });
  });

  it('tells the model which operation replaces git checkout, once, in the facts the mandate notice is built from', () => {
    const forms = operationCatalogueFacts().supersededForms.filter((form) => form.argv.join(' ') === 'git checkout');
    expect(forms).toEqual([{ operation: 'GitBranch', argv: ['git', 'checkout'] }]);
  });
});

describe('the write tools', () => {
  it('are Write and Edit alone: there is no Patch tool', () => {
    const names = createBuiltinTools().map((tool) => tool.name);
    expect(names).not.toContain('Patch');
    expect(names.filter((name) => /patch/i.test(name))).toEqual([]);
    expect(createBuiltinTools().filter((tool) => tool.kind === 'edit').map((tool) => tool.name).sort()).toEqual(['Edit', 'Write']);
  });
});
