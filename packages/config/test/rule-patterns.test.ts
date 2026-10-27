import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadSettings } from '@momonga/config';
import type { PermissionRule } from '@momonga/config';
import { distrusting, makeTree, projectSettingsPath, trusting, userSettingsPath, writeJson } from './helpers.ts';
import type { Tree } from './helpers.ts';

const load = (tree: Tree, trust = trusting(tree)) => loadSettings({ home: tree.home, projectDir: tree.project, cli: {}, trust });

const rejectionOf = async (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => {
      throw new Error('expected a rejection');
    },
    (error: unknown) => error,
  );

const ruleNamed = (rules: readonly PermissionRule[], text: string): PermissionRule => {
  const found = rules.find((rule) => rule.text === text);
  if (found === undefined) throw new Error(`no rule ${text} in ${rules.map((rule) => rule.text).join(', ')}`);
  return found;
};

const exceptionsOf = (rule: PermissionRule): readonly string[] => (rule as PermissionRule & { exceptions?: readonly string[] }).exceptions ?? [];

describe('loadSettings rejects unusable path patterns', () => {
  it.each(['Read(a[b)', 'Read([z-a])', 'Read([[:foo:]]x)', 'Read(a\\)', 'Edit(a/*/../b)', 'Read(~root/.ssh/**)', 'Grep(a[b)', 'Glob([z-a])', 'Write(a[b)'])(
    'a user rule %s is a ConfigError naming the file and the rule',
    async (rule) => {
      const tree = makeTree();
      const file = writeJson(userSettingsPath(tree), { permissions: { deny: [rule] } });
      const error = await rejectionOf(load(tree));
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as Error).message.startsWith(`${file}: invalid permission rule ${JSON.stringify(rule)}: `)).toBe(true);
    },
  );

  it('skips a bad rule in an untrusted project', async () => {
    const tree = makeTree();
    writeJson(projectSettingsPath(tree), { permissions: { deny: ['Read(a[b)'] } });
    const result = await load(tree, distrusting());
    expect(result.rules).toEqual([]);
  });

  it('rejects a bad rule in a trusted project naming the project file', async () => {
    const tree = makeTree();
    const file = writeJson(projectSettingsPath(tree), { permissions: { deny: ['Read(a[b)'] } });
    const error = await rejectionOf(load(tree));
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error).message.startsWith(`${file}: invalid permission rule "Read(a[b)": `)).toBe(true);
  });

  it('rejects a ! pattern in an allow list as negation_in_allow', async () => {
    const tree = makeTree();
    const file = writeJson(userSettingsPath(tree), { permissions: { allow: ['Read(!sample.env)'] } });
    const error = await rejectionOf(load(tree));
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error).message.startsWith(`${file}: invalid permission rule "Read(!sample.env)": `)).toBe(true);
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

describe('loadSettings rejects an empty negation', () => {
  it.each(['Read(!)', 'Read(!.)', 'Read(!./)'])('a user deny list with Read(.env) and %s is a ConfigError with empty specifier', async (rule) => {
    const tree = makeTree();
    const file = writeJson(userSettingsPath(tree), { permissions: { deny: ['Read(.env)', rule] } });
    const error = await rejectionOf(load(tree));
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error).message).toBe(`${file}: invalid permission rule ${JSON.stringify(rule)}: empty specifier`);
  });
});
