import { describe, expect, it } from 'vitest';
import { RuleParseError, parseRule } from '@momonga/policy';

const OPTIONS = { effect: 'allow', origin: 'project', source: '/p/.momonga/settings.json', settingsRoot: '/p', home: '/h', cwd: '/p' } as const;

describe('parseRule', () => {
  it.each([
    ['Read', 'Read', undefined],
    ['Bash(npm run test:*)', 'Bash', 'npm run test:*'],
    ['Bash(git status)', 'Bash', 'git status'],
    ['Read(./src/**)', 'Read', './src/**'],
    ['Edit(//etc/**)', 'Edit', '//etc/**'],
    ['Write(~/notes/*.md)', 'Write', '~/notes/*.md'],
    ['Glob', 'Glob', undefined],
    ['Grep(/docs/**)', 'Grep', '/docs/**'],
    ['ReadOutput', 'ReadOutput', undefined],
    ['UpdatePlan', 'UpdatePlan', undefined],
    ['MemorySave', 'MemorySave', undefined],
    ['MemorySearch', 'MemorySearch', undefined],
    ['mcp__github', 'mcp__github', undefined],
    ['mcp__github__create_issue', 'mcp__github__create_issue', undefined],
  ])('parses %s', (text, tool, specifier) => {
    const rule = parseRule(text, OPTIONS);
    expect(rule.text).toBe(text);
    expect(rule.tool).toBe(tool);
    expect(rule.specifier).toBe(specifier);
    expect(rule.effect).toBe('allow');
    expect(rule.origin).toBe('project');
    expect(rule.source).toBe('/p/.momonga/settings.json');
  });

  it.each(['', 'Bash(unclosed', 'Bash()', 'Frobnicate', 'Read(a))', 'mcp__srv__tool(x)', 'mcp__bad name', 'bash(ls)', 'MemorySave(notes)'])(
    'rejects %j naming the rule text',
    (text) => {
      expect(() => parseRule(text, OPTIONS)).toThrow(RuleParseError);
      expect(() => parseRule(text, OPTIONS)).toThrow(JSON.stringify(text));
    },
  );
});
