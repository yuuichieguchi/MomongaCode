import { describe, expect, it } from 'vitest';
import { TEST_BUILTIN_TOOL_OFFER } from '@momonga/testkit';
import { checkRuleText } from '@momonga/config';
import { BUILTIN_TOOL_NAMES } from '@momonga/protocol';
import { createBuiltinTools } from '@momonga/tools';

describe('permission rules for the built-in tools', () => {
  it('the registry of tool names holds exactly the built-in tools', () => {
    expect([...BUILTIN_TOOL_NAMES].sort()).toEqual(createBuiltinTools(TEST_BUILTIN_TOOL_OFFER).map((tool) => tool.name).sort());
  });

  it.each(createBuiltinTools(TEST_BUILTIN_TOOL_OFFER).map((tool) => tool.name))('a rule can name %s', (name) => {
    expect(checkRuleText(name)).toEqual({ tool: name, specifier: undefined });
  });
});
