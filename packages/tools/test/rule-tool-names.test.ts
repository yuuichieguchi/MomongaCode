import { describe, expect, it } from 'vitest';
import { TEST_BUILTIN_TOOL_OFFER } from '@momonga/testkit';
import { checkRuleText } from '@momonga/config';
import {
  BASH_OUTPUT_TOOL_NAME,
  BUILTIN_TOOL_NAMES,
  COMMAND_TOOL_NAME,
  EDIT_TOOL_NAME,
  GLOB_TOOL_NAME,
  GREP_TOOL_NAME,
  KILL_BASH_TOOL_NAME,
  READ_OUTPUT_TOOL_NAME,
  READ_TOOL_NAME,
  TOOL_NAMES,
  UPDATE_PLAN_TOOL_NAME,
  WRITE_TOOL_NAME,
} from '@momonga/protocol';
import { createBuiltinTools } from '@momonga/tools';

describe('permission rules for the built-in tools', () => {
  it('the registry of tool names holds exactly the built-in tools', () => {
    expect([...BUILTIN_TOOL_NAMES].sort()).toEqual(createBuiltinTools(TEST_BUILTIN_TOOL_OFFER).map((tool) => tool.name).sort());
  });

  it.each([READ_TOOL_NAME, WRITE_TOOL_NAME, EDIT_TOOL_NAME, GLOB_TOOL_NAME, GREP_TOOL_NAME, COMMAND_TOOL_NAME, BASH_OUTPUT_TOOL_NAME, KILL_BASH_TOOL_NAME, READ_OUTPUT_TOOL_NAME, UPDATE_PLAN_TOOL_NAME])(
    'the built-in tool %s is built under its protocol name, an entry of the tool name list',
    (name) => {
      expect(createBuiltinTools(TEST_BUILTIN_TOOL_OFFER).map((tool) => tool.name)).toContain(name);
      expect(TOOL_NAMES).toContain(name);
    },
  );

  it.each(createBuiltinTools(TEST_BUILTIN_TOOL_OFFER).map((tool) => tool.name))('a rule can name %s', (name) => {
    expect(checkRuleText(name)).toEqual({ tool: name, specifier: undefined });
  });
});
