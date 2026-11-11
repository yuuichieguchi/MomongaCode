import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadSettings } from '@momonga/config';
import type { PermissionRule } from '@momonga/config';
import { distrusting, makeTree, projectSettingsPath, trusting, userSettingsPath, writeJson } from './helpers.ts';
import type { Tree } from './helpers.ts';

const load = (tree: Tree, trust = trusting(tree)) => loadSettings({ signal: new AbortController().signal, home: tree.home, projectDir: tree.project, cli: {}, trust });

const ruleNamed = (rules: readonly PermissionRule[], text: string): PermissionRule => {
  const found = rules.find((rule) => rule.text === text);
  if (found === undefined) throw new Error(`no rule ${text} in ${rules.map((rule) => rule.text).join(', ')}`);
  return found;
};

const exceptionsOf = (rule: PermissionRule): readonly string[] => (rule as PermissionRule & { exceptions?: readonly string[] }).exceptions ?? [];

describe('loadSettings ignores an unusable path pattern and keeps the other rules', () => {
  it.each(['Read(a[b)', 'Read([z-a])', 'Read([[:foo:]]x)', 'Read(a\\)', 'Edit(a/*/../b)', 'Read(~root/.ssh/**)', 'Grep(a[b)', 'Glob([z-a])', 'Write(a[b)'])(
    'a user rule %s is ignored with a warning naming the file, the key and the rule',
    async (rule) => {
      const tree = makeTree();
      const file = writeJson(userSettingsPath(tree), { permissions: { deny: ['Read(.env)', rule] } });
      const result = await load(tree);
      expect(result.rules.map((kept) => kept.text)).toEqual(['Read(.env)']);
      expect(result.warnings).toHaveLength(1);
      expect((result.warnings[0] as string).startsWith(`${file}: invalid settings at /permissions/deny/1: invalid permission rule ${JSON.stringify(rule)}: `)).toBe(true);
      expect((result.warnings[0] as string).endsWith('; the rule is ignored')).toBe(true);
    },
  );

  it('skips a bad rule in an untrusted project', async () => {
    const tree = makeTree();
    writeJson(projectSettingsPath(tree), { permissions: { deny: ['Read(a[b)'] } });
    const result = await load(tree, distrusting());
    expect(result.rules).toEqual([]);
  });

  it('ignores a bad rule in a trusted project naming the project file', async () => {
    const tree = makeTree();
    const file = writeJson(projectSettingsPath(tree), { permissions: { deny: ['Read(a[b)'] } });
    const result = await load(tree);
    expect(result.rules).toEqual([]);
    expect(result.warnings.filter((warning) => warning.startsWith(`${file}: invalid settings at /permissions/deny/0: invalid permission rule "Read(a[b)": `))).toHaveLength(1);
  });

  it('ignores a ! pattern in an allow list as negation_in_allow', async () => {
    const tree = makeTree();
    const file = writeJson(userSettingsPath(tree), { permissions: { allow: ['Read(!sample.env)', 'Read(./src/**)'] } });
    const result = await load(tree);
    expect(result.rules.map((kept) => kept.text)).toEqual(['Read(./src/**)']);
    expect(result.warnings).toEqual([`${file}: invalid settings at /permissions/allow/0: invalid permission rule "Read(!sample.env)": negation_in_allow: a ! pattern is not allowed in an allow rule; the rule is ignored`]);
  });
});

describe('loadSettings attaches ! exceptions', () => {
  it('attaches a negation to the earlier relative rules of the same list and tool family and removes it', async () => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), {
      permissions: { deny: ['Read(*.env)', 'Read(./secrets/**)', 'Read(~/x/**)', 'Read(//abs/**)', 'Read(/rooted/**)', 'Write(*.pem)', 'Read(!sample.env)'] },
    });
    const result = await load(tree);
    expect(result.rules.map((rule) => rule.text)).toEqual(['Read(*.env)', 'Read(./secrets/**)', 'Read(~/x/**)', 'Read(//abs/**)', 'Read(/rooted/**)', 'Write(*.pem)']);
    expect(exceptionsOf(ruleNamed(result.rules, 'Read(*.env)'))).toEqual(['sample.env']);
    expect(exceptionsOf(ruleNamed(result.rules, 'Read(./secrets/**)'))).toEqual(['sample.env']);
    expect(exceptionsOf(ruleNamed(result.rules, 'Read(~/x/**)'))).toEqual([]);
    expect(exceptionsOf(ruleNamed(result.rules, 'Read(//abs/**)'))).toEqual([]);
    expect(exceptionsOf(ruleNamed(result.rules, 'Read(/rooted/**)'))).toEqual([]);
    expect(exceptionsOf(ruleNamed(result.rules, 'Write(*.pem)'))).toEqual([]);
  });

  it('treats Write and Edit as one family', async () => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), { permissions: { deny: ['Write(*.pem)', 'Read(*.pem)', 'Edit(!public.pem)'] } });
    const result = await load(tree);
    expect(result.rules.map((rule) => rule.text)).toEqual(['Write(*.pem)', 'Read(*.pem)']);
    expect(exceptionsOf(ruleNamed(result.rules, 'Write(*.pem)'))).toEqual(['public.pem']);
    expect(exceptionsOf(ruleNamed(result.rules, 'Read(*.pem)'))).toEqual([]);
  });

  it('does not attach a negation to a rule of another effect', async () => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), { permissions: { ask: ['Read(*.env)'], deny: ['Read(!sample.env)'] } });
    const result = await load(tree);
    expect(result.rules.map((rule) => rule.text)).toEqual(['Read(*.env)']);
    expect(exceptionsOf(ruleNamed(result.rules, 'Read(*.env)'))).toEqual([]);
    expect(result.warnings.some((warning) => warning.includes('Read(!sample.env)') && warning.includes('carves nothing'))).toBe(true);
  });

  it('reports a negation first in its list as carving nothing', async () => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), { permissions: { deny: ['Read(!sample.env)', 'Read(*.env)'] } });
    const result = await load(tree);
    expect(result.rules.map((rule) => rule.text)).toEqual(['Read(*.env)']);
    expect(exceptionsOf(ruleNamed(result.rules, 'Read(*.env)'))).toEqual([]);
    expect(result.warnings.some((warning) => warning.includes('Read(!sample.env)') && warning.includes('carves nothing'))).toBe(true);
  });

  it("never touches another layer's rules", async () => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), { permissions: { deny: ['Read(*.env)'] } });
    writeJson(projectSettingsPath(tree), { permissions: { deny: ['Read(!sample.env)'] } });
    const result = await load(tree);
    expect(result.rules.map((rule) => rule.text)).toEqual(['Read(*.env)']);
    expect(exceptionsOf(ruleNamed(result.rules, 'Read(*.env)'))).toEqual([]);
    expect(result.warnings.some((warning) => warning.includes('Read(!sample.env)') && warning.includes('carves nothing'))).toBe(true);
  });
});

describe('loadSettings settings roots', () => {
  it('anchors a user rule /path under the momonga user-settings directory', async () => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), { permissions: { deny: ['Read(/secrets/**)'] } });
    const result = await load(tree);
    expect(ruleNamed(result.rules, 'Read(/secrets/**)').settingsRoot).toBe(path.dirname(userSettingsPath(tree)));
  });

  it('anchors a project rule /path at the project directory', async () => {
    const tree = makeTree();
    writeJson(projectSettingsPath(tree), { permissions: { deny: ['Read(/secrets/**)'] } });
    const result = await load(tree);
    expect(ruleNamed(result.rules, 'Read(/secrets/**)').settingsRoot).toBe(tree.project);
  });
});

describe('loadSettings ignores an empty negation', () => {
  it.each(['Read(!)', 'Read(!.)', 'Read(!./)'])('a user deny list with Read(.env) and %s keeps Read(.env) and warns of an empty specifier', async (rule) => {
    const tree = makeTree();
    const file = writeJson(userSettingsPath(tree), { permissions: { deny: ['Read(.env)', rule] } });
    const result = await load(tree);
    expect(result.rules.map((kept) => kept.text)).toEqual(['Read(.env)']);
    expect(result.warnings).toEqual([`${file}: invalid settings at /permissions/deny/1: invalid permission rule ${JSON.stringify(rule)}: empty specifier; the rule is ignored`]);
  });
});
