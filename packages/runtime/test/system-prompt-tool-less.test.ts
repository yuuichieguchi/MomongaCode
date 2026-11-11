import { describe, expect, it } from 'vitest';
import { TOOL_OUTPUT_TAG } from '@momonga/protocol';
import { buildSystemPrompt } from '../src/system-prompt.ts';
import { TEST_FENCE } from '@momonga/testkit';

const CONTEXT = { cwd: '/work', platform: 'darwin', fence: TEST_FENCE };

describe('the system prompt of a run that offers no tools', () => {
  const toolLess = buildSystemPrompt({ ...CONTEXT, tools: 'none', fence: TEST_FENCE });
  const withTools = buildSystemPrompt(CONTEXT);

  it('has no tool section', () => {
    expect(toolLess).not.toContain(`<${TOOL_OUTPUT_TAG}`);
    for (const name of ['ReadOutput', 'RulePropose', 'UpdatePlan']) expect(toolLess).not.toContain(name);
    expect(toolLess).not.toContain('through tools');
    expect(toolLess).not.toMatch(/tool (output|result)s?/i);
  });

  it('still names the working directory and the platform', () => {
    expect(toolLess).toContain('/work');
    expect(toolLess).toContain('darwin');
  });

  it('keeps the tool section for a run that offers tools', () => {
    expect(withTools).toContain(`<${TOOL_OUTPUT_TAG}`);
    expect(withTools).toContain('UpdatePlan');
  });
});
