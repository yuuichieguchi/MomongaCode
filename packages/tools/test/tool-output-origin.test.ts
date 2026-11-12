import { describe, expect, it } from 'vitest';
import { TEST_BUILTIN_TOOL_OFFER } from '@momonga/testkit';
import * as tools from '@momonga/tools';
import type { AnyTool } from '@momonga/tools';
import { makeTool } from './harness.ts';

const outputOriginOf = (tool: AnyTool): string => {
  const derive = (tools as unknown as { outputOriginOf?: (tool: AnyTool) => string }).outputOriginOf;
  if (derive === undefined) throw new Error('@momonga/tools does not export outputOriginOf');
  return derive(tool);
};

const builtin = (name: string): AnyTool => {
  const found = tools.createBuiltinTools(TEST_BUILTIN_TOOL_OFFER).find((tool) => tool.name === name);
  if (found === undefined) throw new Error(`no builtin ${name}`);
  return found;
};

describe('the output declaration of a tool', () => {
  it('defaults to external when a tool declares nothing', () => {
    expect(outputOriginOf(makeTool('Fresh'))).toBe('external');
  });

  it('honours a harness declaration of a built-in tool', () => {
    expect(outputOriginOf(makeTool('Ack', { output: 'harness' } as never))).toBe('harness');
  });

  it('treats every MCP tool as external, whatever it declares', () => {
    expect(outputOriginOf(makeTool('mcp__srv__fetch', { server: 'srv', output: 'harness' } as never))).toBe('external');
  });

  it('declares UpdatePlan harness', () => {
    expect(outputOriginOf(builtin('UpdatePlan'))).toBe('harness');
  });

  it.each(['Read', 'Grep', 'Glob', 'Bash', 'BashOutput', 'ReadOutput'])('keeps %s external', (name) => {
    expect(outputOriginOf(builtin(name))).toBe('external');
  });
});
