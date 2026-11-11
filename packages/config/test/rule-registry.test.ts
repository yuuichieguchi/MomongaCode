import { describe, expect, it } from 'vitest';
import { ConfigError, checkRuleText, loadSettings } from '@momonga/config';
import { OPERATION_RULE_TOOLS, TOOL_NAMES } from '@momonga/protocol';
import { makeTree, projectSettingsPath, trusting, userSettingsPath, writeJson } from './helpers.ts';
import type { Tree } from './helpers.ts';

const load = (tree: Tree) => loadSettings({ signal: new AbortController().signal, home: tree.home, projectDir: tree.project, cli: {}, trust: trusting(tree) });

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
    expect(result.warnings).toEqual([]);
  });

  it('discards a Network rule of the project layer with a warning that names the file and the key', async () => {
    const tree = makeTree();
    const file = writeJson(projectSettingsPath(tree), { permissions: { allow: ['Read(./src/**)', 'Network(*.example.org)'] } });
    const result = await load(tree);
    expect(result.rules.map((rule) => rule.text)).toEqual(['Read(./src/**)']);
    expect(result.warnings).toEqual([`${file}: permissions.allow rule "Network(*.example.org)" is only honored in user settings; discarded`]);
  });

  it('loads the other rules of a file that holds one unreadable rule, and warns once naming that rule', async () => {
    const tree = makeTree();
    const file = writeJson(userSettingsPath(tree), { permissions: { allow: ['Read(./src/**)'], deny: ['Bash(git push:*)', 'Frobnicate', 'Read(.env)'] } });
    const result = await load(tree);
    expect(result.rules.map((rule) => rule.text)).toEqual(['Read(./src/**)', 'Bash(git push:*)', 'Read(.env)']);
    expect(result.warnings).toEqual([`${file}: invalid settings at /permissions/deny/1: invalid permission rule "Frobnicate": unknown tool; the rule is ignored`]);
  });

  it('does not load a mandate that holds an unreadable rule, and loads the others', async () => {
    const tree = makeTree();
    const file = writeJson(userSettingsPath(tree), {
      mandates: {
        tidy: { allow: ['Edit(./src/**)'], deny: ['Frobnicate'] },
        docs: { allow: ['Edit(./docs/**)'] },
      },
    });
    const result = await load(tree);
    expect(Object.keys(result.settings.mandates ?? {})).toEqual(['docs']);
    expect(result.warnings).toEqual([`${file}: invalid settings at /mandates/tidy/deny/0: invalid permission rule "Frobnicate": unknown tool; the mandate tidy is not loaded`]);
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
