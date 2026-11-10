import { describe, expect, it } from 'vitest';
import { EMPTY_PROTECTED_SET } from '@momonga/foundation';
import { decide } from '@momonga/policy';
import type { DecideInput, PermissionRule, PermissionSubject, PolicyTool } from '@momonga/policy';
import type { PermissionMode } from '@momonga/protocol';
import { PERMISSION_MODES } from '@momonga/protocol';
import { TEST_SEARCH_PATH, fakeFs, fileRulesFor, isWritableFor, makeLayout, ruleIn } from './helpers.ts';
import type { Layout } from './helpers.ts';

const MERGE_TOOL: PolicyTool = { name: 'PullRequestMerge', kind: 'other', sideEffect: 'write', subjectKind: 'forge' };
const CREATE_TOOL: PolicyTool = { name: 'PullRequestCreate', kind: 'other', sideEffect: 'write', subjectKind: 'forge' };
const PUSH_TOOL: PolicyTool = { name: 'GitPush', kind: 'other', sideEffect: 'write', subjectKind: 'repo' };
const BASH: PolicyTool = { name: 'Bash', kind: 'execute', sideEffect: 'exec', subjectKind: 'command' };

const NOT_PLAN = PERMISSION_MODES.filter((mode) => mode !== 'plan');

const MERGE = {
  kind: 'forge',
  tool: 'PullRequestMerge',
  operation: 'PullRequestMerge',
  host: 'forge.example',
  repo: 'acme/widgets',
  pr: 7,
  headSha: 'a'.repeat(40),
  approval: 'always',
} as unknown as PermissionSubject;

const CREATE = { kind: 'forge', tool: 'PullRequestCreate', operation: 'PullRequestCreate', host: 'forge.example', repo: 'acme/widgets', approval: 'rule' } as unknown as PermissionSubject;

const push = (ref: string, approval: 'rule' | 'always'): PermissionSubject =>
  ({ kind: 'repo', tool: 'GitPush', operation: 'GitPush', remote: 'origin', refs: [ref], destinations: ['file:///remote.git'], destinationsMatchFetch: true, approval }) as unknown as PermissionSubject;

const SUPERSEDED = [
  { operation: 'GitPush', argv: ['git', 'push'] },
  { operation: 'GitCommit', argv: ['git', 'commit'] },
  { operation: 'PullRequestCreate', argv: ['gh', 'pr', 'create'] },
  { operation: 'PullRequestMerge', argv: ['gh', 'pr', 'merge'] },
];

type Extra = { mandate?: true; supersededForms?: typeof SUPERSEDED };

const decideWith = (layout: Layout, tool: PolicyTool, subject: PermissionSubject, mode: PermissionMode, rules: PermissionRule[], extra: Extra = {}) => {
  const roots = [layout.project];
  const input = {
    tool,
    subject,
    mode,
    rules,
    roots,
    home: layout.home,
    cwd: layout.project,
    fileRules: fileRulesFor(rules, roots),
    protectedSet: EMPTY_PROTECTED_SET,
    fs: fakeFs(),
    searchPath: TEST_SEARCH_PATH,
    isWritable: isWritableFor(roots),
    ...extra,
  } as DecideInput;
  return decide(input);
};

describe('an operation of approval class always (PullRequestMerge)', () => {
  it.each(NOT_PLAN)('asks a person in %s mode, with source operation', (mode) => {
    expect(decideWith(makeLayout(), MERGE_TOOL, MERGE, mode, [])).toMatchObject({ kind: 'ask', source: 'operation', humanOnly: true });
  });

  it.each(NOT_PLAN)('is not lowered by an allow rule in %s mode', (mode) => {
    const layout = makeLayout();
    const rules = [ruleIn(layout)('allow', 'PullRequestMerge(*)'), ruleIn(layout)('allow', 'PullRequestMerge')];
    expect(decideWith(layout, MERGE_TOOL, MERGE, mode, rules)).toMatchObject({ kind: 'ask', source: 'operation', humanOnly: true });
  });

  it('still yields to an explicit deny rule', () => {
    const layout = makeLayout();
    expect(decideWith(layout, MERGE_TOOL, MERGE, 'bypassPermissions', [ruleIn(layout)('deny', 'PullRequestMerge(*)')])).toMatchObject({ kind: 'deny', source: 'rule' });
  });
});

describe('an operation of approval class rule', () => {
  it('asks by the mode default when no rule matches', () => {
    expect(decideWith(makeLayout(), CREATE_TOOL, CREATE, 'manual', [])).toMatchObject({ kind: 'ask', source: 'mode' });
  });

  it('is allowed by a rule naming the operation', () => {
    const layout = makeLayout();
    expect(decideWith(layout, CREATE_TOOL, CREATE, 'manual', [ruleIn(layout)('allow', 'PullRequestCreate(*)')])).toMatchObject({ kind: 'allow', source: 'rule' });
  });

  it('matches a GitPush rule on remote and ref pattern', () => {
    const layout = makeLayout();
    const rules = [ruleIn(layout)('allow', 'GitPush(origin:feature/*)')];
    expect(decideWith(layout, PUSH_TOOL, push('feature/x', 'rule'), 'manual', rules)).toMatchObject({ kind: 'allow', source: 'rule' });
    expect(decideWith(layout, PUSH_TOOL, push('main', 'rule'), 'manual', rules)).toMatchObject({ kind: 'ask', source: 'mode' });
  });

  it('applies a deny rule written for main to a push to Main', () => {
    const layout = makeLayout();
    const rules = [ruleIn(layout)('deny', 'GitPush(origin:main)')];
    expect(decideWith(layout, PUSH_TOOL, push('main', 'rule'), 'manual', rules)).toMatchObject({ kind: 'deny' });
    expect(decideWith(layout, PUSH_TOOL, push('Main', 'rule'), 'manual', rules)).toMatchObject({ kind: 'deny' });
  });

  it('does not let an allow rule for main cover Main, which asks', () => {
    const layout = makeLayout();
    const rules = [ruleIn(layout)('allow', 'GitPush(origin:main)')];
    expect(decideWith(layout, PUSH_TOOL, push('main', 'rule'), 'manual', rules)).toMatchObject({ kind: 'allow', source: 'rule' });
    expect(decideWith(layout, PUSH_TOOL, push('Main', 'rule'), 'manual', rules)).toMatchObject({ kind: 'ask', source: 'mode' });
  });

  it('applies an ask rule written for main to Main', () => {
    const layout = makeLayout();
    const rules = [ruleIn(layout)('allow', 'GitPush(*)'), ruleIn(layout)('ask', 'GitPush(origin:main)')];
    expect(decideWith(layout, PUSH_TOOL, push('Main', 'rule'), 'manual', rules)).toMatchObject({ kind: 'ask' });
  });

  describe('a remote whose push destinations differ from its fetch url', () => {
    const rewritten = (destinations: string[], destinationsMatchFetch: boolean): PermissionSubject =>
      ({ kind: 'repo', tool: 'GitPush', operation: 'GitPush', remote: 'origin', refs: ['feature/x'], destinations, destinationsMatchFetch, approval: 'rule' }) as unknown as PermissionSubject;

    it('asks instead of applying an allow rule written by remote name', () => {
      const layout = makeLayout();
      const rules = [ruleIn(layout)('allow', 'GitPush(origin:*)')];
      expect(decideWith(layout, PUSH_TOOL, rewritten(['file:///fork.git'], false), 'manual', rules)).toMatchObject({ kind: 'ask', source: 'mode' });
      expect(decideWith(layout, PUSH_TOOL, rewritten(['file:///fork.git'], true), 'manual', rules)).toMatchObject({ kind: 'allow', source: 'rule' });
    });

    it('applies an allow rule written for every destination', () => {
      const layout = makeLayout();
      const rules = [ruleIn(layout)('allow', 'GitPush(file:///fork*:*)')];
      expect(decideWith(layout, PUSH_TOOL, rewritten(['file:///fork.git', 'file:///fork2.git'], false), 'manual', rules)).toMatchObject({ kind: 'allow' });
      expect(decideWith(layout, PUSH_TOOL, rewritten(['file:///fork.git', 'file:///other.git'], false), 'manual', rules)).toMatchObject({ kind: 'ask' });
    });

    it('applies a deny rule written by name, and one written for any destination', () => {
      const layout = makeLayout();
      expect(decideWith(layout, PUSH_TOOL, rewritten(['file:///fork.git'], false), 'manual', [ruleIn(layout)('deny', 'GitPush(origin:*)')])).toMatchObject({ kind: 'deny' });
      expect(decideWith(layout, PUSH_TOOL, rewritten(['file:///fork.git', 'file:///prod.git'], false), 'manual', [ruleIn(layout)('deny', 'GitPush(file:///prod.git:*)')])).toMatchObject({ kind: 'deny' });
    });
  });

  it('asks a person for a force push or a protected ref even under a matching allow rule', () => {
    const layout = makeLayout();
    const rules = [ruleIn(layout)('allow', 'GitPush(origin:*)')];
    expect(decideWith(layout, PUSH_TOOL, push('main', 'always'), 'bypassPermissions', rules)).toMatchObject({ kind: 'ask', source: 'operation', humanOnly: true });
  });
});

describe('Bash forms superseded by an operation', () => {
  it.each([
    ['git push origin feature/x', 'GitPush'],
    ['git push --force origin main', 'GitPush'],
    ['gh pr create --fill', 'PullRequestCreate'],
    ['gh pr merge 7 --squash', 'PullRequestMerge'],
  ])('denies %s in a mandate run and names the operation to use', (command, operation) => {
    const layout = makeLayout();
    const subject: PermissionSubject = { kind: 'command', tool: 'Bash', command };
    const decision = decideWith(layout, BASH, subject, 'manual', [ruleIn(layout)('allow', 'Bash(git:*)'), ruleIn(layout)('allow', 'Bash(gh:*)')], { mandate: true, supersededForms: SUPERSEDED });
    expect(decision.kind).toBe('deny');
    expect(decision.reason).toContain(`use ${operation}`);
  });

  it.each([
    ['gh -R acme/widgets pr create --fill', 'PullRequestCreate'],
    ['gh --repo acme/widgets pr merge 7', 'PullRequestMerge'],
    ['gh --hostname ghe.example pr create', 'PullRequestCreate'],
    ['gh pr -R acme/widgets create', 'PullRequestCreate'],
    ['git --exec-path /opt/git push origin main', 'GitPush'],
    ['git --super-prefix sub/ push origin main', 'GitPush'],
    ['git -c user.name=x --config-env=a=B push origin main', 'GitPush'],
    ['env FOO=1 git -C repo --exec-path /x push origin main', 'GitPush'],
  ])('denies %s whatever options come before the subcommand', (command, operation) => {
    const layout = makeLayout();
    const subject: PermissionSubject = { kind: 'command', tool: 'Bash', command };
    const decision = decideWith(layout, BASH, subject, 'manual', [ruleIn(layout)('allow', 'Bash(git:*)'), ruleIn(layout)('allow', 'Bash(gh:*)')], { mandate: true, supersededForms: SUPERSEDED });
    expect(decision.kind).toBe('deny');
    expect(decision.reason).toContain(`use ${operation}`);
  });

  it.each(['git stash push', 'git log --grep push', 'git checkout push', 'gh issue create --title pr', 'git status push'])('does not deny %s, whose words only mention a superseded subcommand', (command) => {
    const layout = makeLayout();
    const subject: PermissionSubject = { kind: 'command', tool: 'Bash', command };
    const decision = decideWith(layout, BASH, subject, 'manual', [], { mandate: true, supersededForms: SUPERSEDED });
    expect(decision.kind).not.toBe('deny');
  });

  it('denies the form only in a mandate run; without a mandate the rules of today decide', () => {
    const layout = makeLayout();
    const subject: PermissionSubject = { kind: 'command', tool: 'Bash', command: 'git push origin feature/x' };
    const allowGit = [ruleIn(layout)('allow', 'Bash(git:*)')];
    expect(decideWith(layout, BASH, subject, 'manual', allowGit, { mandate: true, supersededForms: SUPERSEDED })).toMatchObject({ kind: 'deny' });
    expect(decideWith(layout, BASH, subject, 'manual', [], { supersededForms: SUPERSEDED })).toMatchObject({ kind: 'ask', source: 'mode' });
    expect(decideWith(layout, BASH, subject, 'manual', allowGit, { supersededForms: SUPERSEDED })).toMatchObject({ kind: 'allow' });
  });

  it('leaves a git command that no operation replaces alone in a mandate run', () => {
    const layout = makeLayout();
    const push: PermissionSubject = { kind: 'command', tool: 'Bash', command: 'git push origin main' };
    const status: PermissionSubject = { kind: 'command', tool: 'Bash', command: 'git status' };
    expect(decideWith(layout, BASH, push, 'manual', [], { mandate: true, supersededForms: SUPERSEDED }).kind).toBe('deny');
    expect(decideWith(layout, BASH, status, 'manual', [], { mandate: true, supersededForms: SUPERSEDED }).kind).not.toBe('deny');
  });
});
