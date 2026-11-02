import { describe, expect, it } from 'vitest';
import { PATH_TOOLS, PATH_TOOL_RULES, isPathTool, parseRule } from '@momonga/config';
import { HOST_RULE_ENFORCEMENT } from '@momonga/foundation';
import { computeFileRules, fileRuleSpecsOf } from '@momonga/policy';
import { EDIT_FAMILY, READ_FAMILY } from '../src/match-rule.ts';
import { makeLayout } from './helpers.ts';

describe('one table of path tools (DUP-24)', () => {
  it('lists exactly the record keys', () => {
    expect([...PATH_TOOLS].sort()).toEqual(['Edit', 'Glob', 'Grep', 'Read', 'Write']);
    expect(Object.keys(PATH_TOOL_RULES).sort()).toEqual([...PATH_TOOLS].sort());
  });

  it('recognises path tools and nothing else', () => {
    for (const tool of PATH_TOOLS) expect(isPathTool(tool)).toBe(true);
    for (const tool of ['Bash', 'WebFetch', 'mcp__srv__run', 'read']) expect(isPathTool(tool)).toBe(false);
  });

  it.each(['allow', 'ask', 'deny'] as const)('compiles every path tool rule with effect %s to exactly one spec of the record', (effect) => {
    const layout = makeLayout();
    for (const tool of PATH_TOOLS) {
      const rule = parseRule(`${tool}(/x/**)`, { effect, origin: 'user', source: 'user-settings', settingsRoot: layout.project, home: layout.home, cwd: layout.project });
      const specs = fileRuleSpecsOf([rule], [layout.project]);
      expect(specs).toHaveLength(1);
      expect(specs[0]).toMatchObject({ tool: PATH_TOOL_RULES[tool].tool, access: PATH_TOOL_RULES[tool].access, effect });
      expect(computeFileRules([rule], [layout.project], null, HOST_RULE_ENFORCEMENT).entries.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('maps Write and Edit to the Edit file-rule tool with write access and the read tools to read access', () => {
    expect(PATH_TOOL_RULES).toEqual({
      Read: { tool: 'Read', access: 'read' },
      Write: { tool: 'Edit', access: 'write' },
      Edit: { tool: 'Edit', access: 'write' },
      Glob: { tool: 'Glob', access: 'read' },
      Grep: { tool: 'Grep', access: 'read' },
    });
  });

  it('derives the edit and read families from the record', () => {
    expect(new Set(EDIT_FAMILY)).toEqual(new Set(['Write', 'Edit']));
    expect(new Set(READ_FAMILY)).toEqual(new Set(['Read', 'Glob', 'Grep']));
  });
});
