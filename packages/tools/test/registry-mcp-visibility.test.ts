import { describe, expect, it } from 'vitest';
import { createToolRegistry } from '@momonga/tools';
import type { AnyTool } from '@momonga/tools';
import { call, makeHarness, makeTool } from './harness.ts';
import { ruleFor } from './helpers.ts';

const mcpTool = (server: string, tool: string): AnyTool =>
  makeTool(`mcp__${server}__${tool}`, {
    kind: 'other',
    sideEffect: 'write', subjectKind: 'mcp',
    subject: () => ({ kind: 'mcp', server, tool }),
  });

const snapshot = async () => {
  const registry = createToolRegistry();
  registry.register(makeTool('Read'));
  registry.addSource({ id: 'mcp__srv', list: async () => [mcpTool('srv', 'echo'), mcpTool('srv', 'add')] });
  registry.addSource({ id: 'mcp__other', list: async () => [mcpTool('other', 'echo')] });
  return registry.snapshot();
};

describe('registry visibility of MCP tools under deny rules', () => {
  it('hides every tool of a server denied by mcp__srv', async () => {
    const harness = makeHarness();
    const rule = ruleFor(harness.layout);
    const set = await snapshot();
    expect(set.forModel({ mode: 'default', rules: [rule('deny', 'mcp__srv')] }).map((tool) => tool.name)).toEqual(['Read', 'mcp__other__echo']);
  });

  it('hides only the tool denied by mcp__srv__echo', async () => {
    const harness = makeHarness();
    const rule = ruleFor(harness.layout);
    const set = await snapshot();
    expect(set.forModel({ mode: 'default', rules: [rule('deny', 'mcp__srv__echo')] }).map((tool) => tool.name)).toEqual([
      'Read',
      'mcp__srv__add',
      'mcp__other__echo',
    ]);
  });

  it.each(['mcp__srv', 'mcp__srv__echo'])('denies a call to a tool hidden by %s even with an approval', async (text) => {
    const harness = makeHarness();
    const rule = ruleFor(harness.layout);
    const set = await snapshot();
    const [outcome] = await harness.executor.runBatch(
      harness.input(set, [call('c1', 'mcp__srv__echo', {}, 'allow_once')], { rules: [rule('deny', text)] }),
    );
    expect(outcome).toMatchObject({ kind: 'result', result: { status: 'failed' } });
    expect(outcome?.kind === 'result' ? outcome.result.output.startsWith('Permission denied') : false).toBe(true);
    expect(harness.started).toEqual([]);
  });
});
