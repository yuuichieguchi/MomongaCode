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

type Extra = { mandate?: true; supersededForms?: typeof SUPERSEDED; coveredPrograms?: Array<{ program: string; flagOptions: string[]; valueOptions: string[]; injecting: string[]; readOnly: string[][] }> };

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

  it.each(['git stash push', 'git log --grep push', 'git checkout push', 'gh issue create --title pr', 'git status push'])('does not take %s for a superseded form, whose words only mention a superseded subcommand', (command) => {
    const layout = makeLayout();
    const subject: PermissionSubject = { kind: 'command', tool: 'Bash', command };
    const decision = decideWith(layout, BASH, subject, 'manual', [], { mandate: true, supersededForms: SUPERSEDED });
    expect(decision.reason).not.toContain('replaced by a dedicated operation');
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

  describe('a command whose words up to the subcommand are not all literal', () => {
    const UNDECIDABLE = ['git $X origin main', 'git -c a=b "$(echo push)"', 'G=git; $G push', 'gh pr $(echo create)'];
    const allowAll = (layout: Layout) => [ruleIn(layout)('allow', 'Bash(git:*)'), ruleIn(layout)('allow', 'Bash(gh:*)'), ruleIn(layout)('allow', 'Bash')];

    it.each(UNDECIDABLE)('is not run without a person in a mandate run, whatever the allow rules and the mode: %s', (command) => {
      const layout = makeLayout();
      const subject: PermissionSubject = { kind: 'command', tool: 'Bash', command };
      for (const mode of ['manual', 'bypassPermissions'] as const) {
        const decision = decideWith(layout, BASH, subject, mode, allowAll(layout), { mandate: true, supersededForms: SUPERSEDED });
        expect(decision).toMatchObject({ kind: 'ask', source: 'operation', humanOnly: true });
        expect(decision.reason).toContain('could be');
      }
    });

    it.each(UNDECIDABLE)('takes the ordinary path without a mandate: %s', (command) => {
      const layout = makeLayout();
      const subject: PermissionSubject = { kind: 'command', tool: 'Bash', command };
      const without = decideWith(layout, BASH, subject, 'manual', [], {});
      expect(decideWith(layout, BASH, subject, 'manual', [], { supersededForms: SUPERSEDED })).toEqual(without);
      expect(without.source).not.toBe('operation');
    });

    it('still yields to a deny rule in a mandate run', () => {
      const layout = makeLayout();
      const subject: PermissionSubject = { kind: 'command', tool: 'Bash', command: 'git $X origin main' };
      expect(decideWith(layout, BASH, subject, 'manual', [ruleIn(layout)('deny', 'Bash(git:*)')], { mandate: true, supersededForms: SUPERSEDED })).toMatchObject({ kind: 'deny', source: 'rule' });
    });

    it.each(['git push origin "$BRANCH"', 'gh pr create --title "$(cat title)"'])('is still the superseded form when the non-literal word comes after it: %s', (command) => {
      const layout = makeLayout();
      const subject: PermissionSubject = { kind: 'command', tool: 'Bash', command };
      expect(decideWith(layout, BASH, subject, 'manual', [], { mandate: true, supersededForms: SUPERSEDED })).toMatchObject({ kind: 'deny' });
    });

    it.each(['git status $X', 'npm run $X', 'ls $DIR'])('is not held when a literal word already rules every form out: %s', (command) => {
      const layout = makeLayout();
      const subject: PermissionSubject = { kind: 'command', tool: 'Bash', command };
      expect(decideWith(layout, BASH, subject, 'manual', [], { mandate: true, supersededForms: SUPERSEDED }).source).not.toBe('operation');
    });
  });
});

describe('what a person is asked about names where the operation goes', () => {
  it('names the ref, the remote and every destination of a push', () => {
    expect(decideWith(makeLayout(), PUSH_TOOL, push('main', 'always'), 'manual', []).reason).toBe('GitPush always needs a person to approve it, in every mode; target: main at origin (file:///remote.git)');
  });

  it('names the repository, the pull request, the host and the approved commit of a merge', () => {
    expect(decideWith(makeLayout(), MERGE_TOOL, MERGE, 'manual', []).reason).toBe(`PullRequestMerge always needs a person to approve it, in every mode; target: acme/widgets #7 on forge.example at commit ${'a'.repeat(40)}`);
  });
});

describe('a covered program is judged by what is known to be read-only, not by what is known to write', () => {
  const PROGRAMS = [
    { program: 'git', flagOptions: ['--no-pager'], valueOptions: ['-C', '-c', '--exec-path', '--config-env'], injecting: ['-c', '--config-env', '--exec-path'], readOnly: [['status'], ['log'], ['diff']] },
    { program: 'gh', flagOptions: [], valueOptions: ['-R', '--repo'], injecting: [], readOnly: [['pr', 'view'], ['pr', 'list'], ['status']] },
  ];
  const decideIn = (command: string, rules: Array<[('allow' | 'deny'), string]> = [], mandate = true) => {
    const layout = makeLayout();
    const subject: PermissionSubject = { kind: 'command', tool: 'Bash', command };
    return decideWith(layout, BASH, subject, 'manual', rules.map(([effect, text]) => ruleIn(layout)(effect, text)), { ...(mandate ? { mandate: true as const } : {}), supersededForms: SUPERSEDED, coveredPrograms: PROGRAMS });
  };

  it.each(['git -c alias.x=push x origin main', 'git --config-env=alias.x=A x', 'git x', 'git rebase main', 'git --exec-path=/tmp/evil status', 'gh pr new', 'gh api -X POST repos/acme/widgets/pulls', 'gh api repos/acme/widgets/pulls/7/merge -X PUT', 'git --no-pager rebase log', 'git'])(
    'needs a person in a mandate run, whatever the allow rules: %s',
    (command) => {
      expect(decideIn(command, [['allow', 'Bash(git:*)'], ['allow', 'Bash(gh:*)']])).toMatchObject({ kind: 'ask', source: 'operation', humanOnly: true });
    },
  );

  it.each(['git status', 'git log --grep push', 'git -C sub diff', 'git --no-pager log -3', 'gh pr view 7', 'gh -R acme/widgets pr list', 'gh status'])('leaves a recognised read-only form to the ordinary decision: %s', (command) => {
    expect(decideIn(command).source).not.toBe('operation');
  });

  it.each([
    ['git -c alias.push=x push origin main', 'GitPush'],
    ['git --no-pager commit -m log', 'GitCommit'],
    ['gh pr create --fill', 'PullRequestCreate'],
  ])('still denies a recognised superseded form and names the operation: %s', (command, operation) => {
    const decision = decideIn(command);
    expect(decision.kind).toBe('deny');
    expect(decision.reason).toContain(`use ${operation}`);
  });

  it.each(['git x', 'gh pr new', 'git -c alias.x=push x'])('takes the ordinary path without a mandate: %s', (command) => {
    const without = decideIn(command, [], false);
    expect(without.source).not.toBe('operation');
    expect(without).toEqual(decideWith(makeLayout(), BASH, { kind: 'command', tool: 'Bash', command }, 'manual', [], {}));
  });

  it('leaves a program the catalogue does not cover alone', () => {
    expect(decideIn('npm run push', [['allow', 'Bash(npm run:*)']])).toMatchObject({ kind: 'allow', source: 'rule' });
  });
});

describe('a decision the mode default would ask about, in a mandate run', () => {
  const bash = (command: string): PermissionSubject => ({ kind: 'command', tool: 'Bash', command });

  it('is denied as outside the mandate, and asked as today without one', () => {
    const layout = makeLayout();
    const inMandate = decideWith(layout, BASH, bash('npm install left-pad'), 'manual', [], { mandate: true });
    expect(inMandate).toMatchObject({ kind: 'deny', source: 'mode', outside: true });
    expect(inMandate.reason).toBe('Not run: outside the declared mandate (shell commands require approval). Continue with work inside it or report.');
    expect(decideWith(layout, BASH, bash('npm install left-pad'), 'manual', [])).toMatchObject({ kind: 'ask', source: 'mode' });
  });

  it('is denied for an operation no rule of the mandate names', () => {
    expect(decideWith(makeLayout(), CREATE_TOOL, CREATE, 'manual', [], { mandate: true })).toMatchObject({ kind: 'deny', outside: true });
  });

  it('runs what an allow rule covers and keeps a read-only command allowed', () => {
    const layout = makeLayout();
    expect(decideWith(layout, BASH, bash('npm test'), 'manual', [ruleIn(layout)('allow', 'Bash(npm test:*)')], { mandate: true })).toMatchObject({ kind: 'allow', source: 'rule' });
    expect(decideWith(layout, BASH, bash('ls'), 'manual', [], { mandate: true })).toMatchObject({ kind: 'allow' });
  });

  it('stays an ask, to be held for a person, when a rule asks, when the operation is of class always, and when only a person may decide', () => {
    const layout = makeLayout();
    expect(decideWith(layout, PUSH_TOOL, push('main', 'rule'), 'manual', [ruleIn(layout)('ask', 'GitPush(origin:main)')], { mandate: true })).toMatchObject({ kind: 'ask', source: 'rule' });
    expect(decideWith(layout, MERGE_TOOL, MERGE, 'manual', [ruleIn(layout)('allow', 'PullRequestMerge')], { mandate: true })).toMatchObject({ kind: 'ask', source: 'operation' });
  });
});
