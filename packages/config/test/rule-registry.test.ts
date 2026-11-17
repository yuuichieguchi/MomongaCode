import { describe, expect, it } from 'vitest';
import { ConfigError, checkRuleText, loadSettings } from '@momonga/config';
import { OPERATION_RULE_TOOLS, TOOL_NAMES } from '@momonga/protocol';
import { makeTree, projectSettingsPath, trusting, userSettingsPath, writeJson } from './helpers.ts';
import type { Tree } from './helpers.ts';

const load = (tree: Tree) => loadSettings({ env: process.env, signal: new AbortController().signal, home: tree.home, projectDir: tree.project, cli: {}, trust: trusting(tree) });

describe('the rule grammar reads its names from the registry of tools', () => {
  it.each([...TOOL_NAMES])('accepts a rule that names %s', (name) => {
    expect(checkRuleText(name)).toEqual({ tool: name, specifier: undefined });
  });

  it('holds the tools the runtime, the skills and the agents register', () => {
    expect(TOOL_NAMES).toEqual(expect.arrayContaining(['Agent', 'LoadTools', 'activate_skill']));
  });

  it('loads rules for Agent, LoadTools and activate_skill', async () => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), { permissions: { allow: ['Agent', 'LoadTools'], deny: ['activate_skill'] } });
    const result = await load(tree);
    expect(result.rules.map((rule) => rule.tool).sort()).toEqual(['Agent', 'LoadTools', 'activate_skill']);
    expect(result.warnings).toEqual([]);
  });
});

describe('rule forms', () => {
  it('reads mcp__<server>__* as the rule of the whole server', () => {
    expect(checkRuleText('mcp__github__*')).toEqual({ tool: 'mcp__github', specifier: undefined });
  });

  it.each(['mcp__github__*x', 'mcp__*', 'mcp__github__a*'])('refuses %s naming the form that is accepted', (text) => {
    expect(() => checkRuleText(text)).toThrow('mcp__<server>__*');
  });

  it('keeps balanced parentheses of a path specifier as text', () => {
    expect(checkRuleText('Edit(app/(auth)/**)')).toEqual({ tool: 'Edit', specifier: 'app/(auth)/**' });
  });

  it('refuses unbalanced parentheses in a path specifier', () => {
    expect(() => checkRuleText('Edit(app/(auth/**)')).toThrow('unbalanced parentheses');
  });

  it.each(['Bash(curl *)', 'Bash(* --version)', 'Bash(git * main)'])('accepts the command glob %s', (text) => {
    expect(checkRuleText(text).tool).toBe('Bash');
  });

  it.each(['Network(example.org)', 'Network(*.example.org)', 'Network(192.168.1.20)', 'Network(example.org:8443)'])('accepts %s', (text) => {
    expect(checkRuleText(text).tool).toBe('Network');
  });

  it.each(['Network', 'Network(*)', 'Network(*.)', 'Network(ex ample.org)', 'Network(a.*.org)'])('refuses %s', (text) => {
    expect(() => checkRuleText(text)).toThrow('invalid permission rule');
  });
});

describe('rules at load', () => {
  it('keeps a Network rule of the user layer', async () => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), { permissions: { allow: ['Network(*.example.org)'] } });
    const result = await load(tree);
    expect(result.rules).toMatchObject([{ tool: 'Network', specifier: '*.example.org', effect: 'allow', origin: 'user' }]);
  });

  it('loads a Network rule of the user layer and of a mandate without a warning: the rule is enforced', async () => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), { permissions: { allow: ['Network(*.example.org)'], deny: ['Network(tracker.example.org)'] }, mandates: { tidy: { allow: ['Network(example.org)'] } } });
    const result = await load(tree);
    expect(result.warnings).toEqual([]);
    expect(result.rules.map((rule) => rule.text).sort()).toEqual(['Network(*.example.org)', 'Network(tracker.example.org)']);
  });

  it('discards a Network rule of the project layer with a warning that names the file and the key', async () => {
    const tree = makeTree();
    const file = writeJson(projectSettingsPath(tree), { permissions: { allow: ['Read(./src/**)', 'Network(*.example.org)'] } });
    const result = await load(tree);
    expect(result.rules.map((rule) => rule.text)).toEqual(['Read(./src/**)']);
    expect(result.warnings).toEqual([`${file}: permissions.allow rule "Network(*.example.org)" is only honored in user settings; discarded`]);
  });

  it('ignores an allow rule that cannot be read, warns once naming it, and keeps the valid rules in force', async () => {
    const tree = makeTree();
    const file = writeJson(userSettingsPath(tree), { permissions: { allow: ['Read(./src/**)', 'Frobnicate', 'Bash(npm test)'], deny: ['Bash(git push:*)', 'Read(.env)'] } });
    const result = await load(tree);
    expect(result.rules.map((rule) => rule.text)).toEqual(['Read(./src/**)', 'Bash(npm test)', 'Bash(git push:*)', 'Read(.env)']);
    expect(result.warnings).toEqual([`${file}: invalid settings at /permissions/allow/1: invalid permission rule "Frobnicate": unknown tool; the rule is ignored`]);
  });

  it.each(['deny', 'ask'] as const)('refuses the load for a %s rule that cannot be read, naming the file, the key, the rule and the reason', async (effect) => {
    const tree = makeTree();
    const file = writeJson(userSettingsPath(tree), { permissions: { allow: ['Read(./src/**)'], [effect]: ['Bash(git push:*)', 'Frobnicate'] } });
    const failure = load(tree);
    await expect(failure).rejects.toBeInstanceOf(ConfigError);
    await expect(failure).rejects.toThrow(`${file}: invalid settings at /permissions/${effect}/1: invalid permission rule "Frobnicate": unknown tool`);
  });

  it('loads a mandate without its allow rule that cannot be read, and warns naming the rule', async () => {
    const tree = makeTree();
    const file = writeJson(userSettingsPath(tree), { mandates: { tidy: { allow: ['Edit(./src/**)', 'Frobnicate'], deny: ['Bash(curl:*)'] } } });
    const result = await load(tree);
    expect(result.settings.mandates).toEqual({ tidy: { allow: ['Edit(./src/**)'], deny: ['Bash(curl:*)'] } });
    expect(result.warnings).toEqual([`${file}: invalid settings at /mandates/tidy/allow/1: invalid permission rule "Frobnicate": unknown tool; the rule is ignored`]);
  });

  it.each(['deny', 'ask'] as const)('refuses the load for a %s rule of a mandate that cannot be read', async (effect) => {
    const tree = makeTree();
    const file = writeJson(userSettingsPath(tree), { mandates: { tidy: { allow: ['Edit(./src/**)'], [effect]: ['Frobnicate'] } } });
    const failure = load(tree);
    await expect(failure).rejects.toBeInstanceOf(ConfigError);
    await expect(failure).rejects.toThrow(`${file}: invalid settings at /mandates/tidy/${effect}/0: invalid permission rule "Frobnicate": unknown tool`);
  });

  it('refuses an operation name the catalogue does not have, naming the names it has', async () => {
    const tree = makeTree();
    const file = writeJson(userSettingsPath(tree), { operations: { approval: { GitPsuh: 'always' } } });
    const failure = load(tree);
    await expect(failure).rejects.toBeInstanceOf(ConfigError);
    await expect(failure).rejects.toThrow(`${file}: invalid settings at /operations/approval/GitPsuh: not an operation; the operations are ${OPERATION_RULE_TOOLS.join(', ')}`);
  });

  it('accepts every operation of the catalogue under operations.approval', async () => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), { operations: { approval: Object.fromEntries(OPERATION_RULE_TOOLS.map((name) => [name, 'always'])) } });
    const result = await load(tree);
    expect(Object.keys(result.settings.operations?.approval ?? {})).toEqual([...OPERATION_RULE_TOOLS]);
  });
});
