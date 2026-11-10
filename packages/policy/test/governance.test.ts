import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EMPTY_PROTECTED_SET } from '@momonga/foundation';
import { decide, suggestAllowRule } from '@momonga/policy';
import type { PermissionRule, PermissionSubject, PolicyTool } from '@momonga/policy';
import type { PermissionMode } from '@momonga/protocol';
import { PERMISSION_MODES } from '@momonga/protocol';
import { TEST_SEARCH_PATH, fakeFs, fileRulesFor, isWritableFor, makeLayout, ruleIn, touch } from './helpers.ts';
import type { Layout } from './helpers.ts';

const BASH: PolicyTool = { name: 'Bash', kind: 'execute', sideEffect: 'exec', subjectKind: 'command' };
const READ: PolicyTool = { name: 'Read', kind: 'read', sideEffect: 'read_only' };
const PROPOSE: PolicyTool = { name: 'RulePropose', kind: 'other', sideEffect: 'write', subjectKind: 'governance' };
const GOVERNANCE: PermissionSubject = {
  kind: 'governance',
  tool: 'RulePropose',
  factKind: 'constraint',
  target: 'pandas',
  text: 'do not use pandas',
  scope: { level: 'user' },
  enforcement: null,
  supersedes: [],
};
const RM: PermissionSubject = { kind: 'command', tool: 'Bash', command: 'rm -rf build' };

const governed = (layout: Layout, effect: 'deny' | 'ask', text: string): PermissionRule => ({ ...ruleIn(layout)(effect, text), layer: 'governance' });

const decideWith = (layout: Layout, tool: PolicyTool, subject: PermissionSubject, mode: PermissionMode, rules: PermissionRule[]) => {
  const roots = [layout.project];
  return decide({
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
  });
};

describe('the governance subject', () => {
  it.each(PERMISSION_MODES)('asks a person in %s mode', (mode) => {
    expect(decideWith(makeLayout(), PROPOSE, GOVERNANCE, mode, [])).toMatchObject({ kind: 'ask', humanOnly: true });
  });

  it.each(PERMISSION_MODES)('cannot be allowed by a rule in %s mode', (mode) => {
    const layout = makeLayout();
    const allow = { ...ruleIn(layout)('allow', 'Read'), tool: 'RulePropose', text: 'RulePropose' };
    expect(decideWith(layout, PROPOSE, GOVERNANCE, mode, [allow])).toMatchObject({ kind: 'ask', humanOnly: true });
  });

  it('suggests no allow rule', () => {
    const canonicalise = () => {
      throw new Error('a governance subject names no path');
    };
    expect(suggestAllowRule(PROPOSE, GOVERNANCE, '/work', canonicalise)).toBeUndefined();
  });
});

describe('a governance rule', () => {
  it.each(PERMISSION_MODES)('denies in %s mode', (mode) => {
    const layout = makeLayout();
    const decision = decideWith(layout, BASH, RM, mode, [governed(layout, 'deny', 'Bash(rm:*)')]);
    expect(decision).toMatchObject({ kind: 'deny', source: 'rule' });
  });

  it.each(PERMISSION_MODES)('asks a person in %s mode', (mode) => {
    const layout = makeLayout();
    const decision = decideWith(layout, BASH, RM, mode, [governed(layout, 'ask', 'Bash(rm:*)')]);
    expect(decision).toMatchObject({ kind: 'ask', source: 'rule', humanOnly: true });
  });

  it('asks on a read-only tool in plan and bypass modes', () => {
    const layout = makeLayout();
    const subject: PermissionSubject = { kind: 'path', tool: 'Read', paths: [touch(path.join(layout.project, 'a.txt'))], access: 'read' };
    for (const mode of ['plan', 'bypassPermissions'] as const) {
      expect(decideWith(layout, READ, subject, mode, [governed(layout, 'ask', 'Read')])).toMatchObject({ kind: 'ask', humanOnly: true });
    }
  });

  it('is not bypassed by an allow rule of the settings', () => {
    const layout = makeLayout();
    const rules = [ruleIn(layout)('allow', 'Bash(rm:*)'), governed(layout, 'ask', 'Bash(rm:*)')];
    expect(decideWith(layout, BASH, RM, 'bypassPermissions', rules)).toMatchObject({ kind: 'ask', humanOnly: true });
  });

  describe('on a path the command builds at run time', () => {
    const DYNAMIC: PermissionSubject = { kind: 'command', tool: 'Bash', command: 'cat $(echo secrets/key)' };

    it.each(PERMISSION_MODES.filter((mode) => mode !== 'plan'))('asks a person in %s mode, because the rule cannot be matched against a path that is not known', (mode) => {
      const layout = makeLayout();
      const decision = decideWith(layout, BASH, DYNAMIC, mode, [governed(layout, 'ask', 'Read(secrets/**)')]);
      expect(decision).toMatchObject({ kind: 'ask', humanOnly: true });
    });

    it('asks a person in plan mode too', () => {
      const layout = makeLayout();
      expect(decideWith(layout, BASH, DYNAMIC, 'plan', [governed(layout, 'ask', 'Read(secrets/**)')]).kind).not.toBe('allow');
    });

    it('holds for a deny rule as well, in bypass', () => {
      const layout = makeLayout();
      expect(decideWith(layout, BASH, DYNAMIC, 'bypassPermissions', [governed(layout, 'deny', 'Read(secrets/**)')])).toMatchObject({ kind: 'ask', humanOnly: true });
    });

    it('stays as before when no governing rule covers reading, in bypass', () => {
      const layout = makeLayout();
      expect(decideWith(layout, BASH, DYNAMIC, 'bypassPermissions', [ruleIn(layout)('ask', 'Read(secrets/**)')]).kind).toBe('allow');
      expect(decideWith(layout, BASH, DYNAMIC, 'bypassPermissions', [governed(layout, 'ask', 'Bash(rm:*)')]).kind).toBe('allow');
    });

    it('is not a human-only question when only the settings hold the rule, so a hook or the classifier may still answer it', () => {
      const layout = makeLayout();
      const decision = decideWith(layout, BASH, DYNAMIC, 'manual', [ruleIn(layout)('ask', 'Read(secrets/**)')]);
      expect(decision.kind).toBe('ask');
      expect(decision.humanOnly).toBeUndefined();
    });
  });

  it('leaves a settings ask overridable by bypass, as before', () => {
    const layout = makeLayout();
    const decision = decideWith(layout, BASH, RM, 'bypassPermissions', [ruleIn(layout)('ask', 'Bash(rm:*)')]);
    expect(decision.kind).toBe('allow');
    expect(decision.humanOnly).toBeUndefined();
  });
});
