import { describe, expect, it } from 'vitest';
import type { FunctionTool, PermissionMode } from '@momonga/protocol';
import { createBuiltinTools, createGovernanceTools, createHistoryTools, createMemoryTools, createToolRegistry, defineTool } from '@momonga/tools';
import type { AnyTool, ToolSet } from '@momonga/tools';

const MODE: PermissionMode = 'default';

const allOwnedTools = (): AnyTool[] => [
  ...createBuiltinTools(),
  ...createMemoryTools({ port: {} as never, trusted: true }),
  ...createHistoryTools({ port: {} as never, trusted: true, project: '/work/a' }),
  ...createGovernanceTools({ port: {} as never, trusted: true }),
];

const OWNED_NAMES = ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'BashOutput', 'KillBash', 'ReadOutput', 'UpdatePlan', 'MemorySave', 'MemorySearch', 'HistorySearch', 'HistoryRead', 'RulePropose'];

const FILE_TOOLS = ['Read', 'Write', 'Edit', 'Glob', 'Grep'];

const PLAIN_DESCRIPTION = 'A plain tool with a long description that has no concise variant at all.';

const snapshotOf = async (tools: readonly AnyTool[]): Promise<ToolSet> => {
  const registry = createToolRegistry();
  for (const tool of tools) registry.register(tool);
  return registry.snapshot();
};

const offered = (set: ToolSet, conciseDescriptions?: boolean): Map<string, FunctionTool> => {
  const options = conciseDescriptions === undefined ? { mode: MODE, rules: [] } : { mode: MODE, rules: [], conciseDescriptions };
  return new Map(set.forModel(options as Parameters<ToolSet['forModel']>[0]).map((tool) => [tool.name, tool]));
};

const descriptionOf = (tools: Map<string, FunctionTool>, name: string): string => {
  const tool = tools.get(name);
  if (tool === undefined) throw new Error(`${name} is not offered`);
  return tool.description ?? '';
};

const withoutDescription = (tools: Map<string, FunctionTool>): Omit<FunctionTool, 'description'>[] =>
  [...tools.values()].map(({ description: _description, ...rest }) => rest);

const plainTool = (name: string, variant: Record<string, unknown> = {}): AnyTool =>
  ({
    ...defineTool<Record<string, never>>({
      name,
      description: PLAIN_DESCRIPTION,
      kind: 'other',
      sideEffect: 'read_only',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      timeoutMs: 1000,
      title: () => name,
      subject: () => ({ kind: 'none', tool: name }),
      execute: async () => ({ status: 'completed', output: '' }),
    }),
    ...variant,
  }) as AnyTool;

describe('concise tool descriptions (T3-6)', () => {
  it('offers every owned tool under test', async () => {
    const tools = offered(await snapshotOf(allOwnedTools()), true);
    expect(OWNED_NAMES.filter((name) => !tools.has(name))).toEqual([]);
  });

  it.each(OWNED_NAMES)('%s offers a non-empty concise description strictly shorter than its full one', async (name) => {
    const set = await snapshotOf(allOwnedTools());
    const full = descriptionOf(offered(set, false), name);
    const concise = descriptionOf(offered(set, true), name);
    expect(concise.trim().length).toBeGreaterThan(0);
    expect(concise.length).toBeLessThan(full.length);
  });

  it.each(OWNED_NAMES)('%s keeps the full description when concise descriptions are off or not asked for', async (name) => {
    const set = await snapshotOf(allOwnedTools());
    const tool = set.get(name);
    expect(descriptionOf(offered(set), name)).toBe(tool?.description);
    expect(descriptionOf(offered(set, false), name)).toBe(tool?.description);
  });

  it('changes only the descriptions between the two variants', async () => {
    const set = await snapshotOf(allOwnedTools());
    expect(withoutDescription(offered(set, true))).toEqual(withoutDescription(offered(set, false)));
  });

  it.each(FILE_TOOLS)('%s concise description still says a relative path is resolved against the working directory', async (name) => {
    const concise = descriptionOf(offered(await snapshotOf(allOwnedTools()), true), name);
    expect(concise).not.toMatch(/must be (an )?absolute/i);
    expect(concise).not.toMatch(/^absolute/i);
    expect(concise).toMatch(/relative .*resolved against the working directory/i);
  });

  it('falls back to the full description for a tool without a concise variant', async () => {
    const set = await snapshotOf([plainTool('Plain')]);
    expect(descriptionOf(offered(set, true), 'Plain')).toBe(PLAIN_DESCRIPTION);
  });

  it('gives the same digest to two snapshots of the same tools', async () => {
    expect((await snapshotOf(allOwnedTools())).digest).toBe((await snapshotOf(allOwnedTools())).digest);
  });

  it('covers the concise variant in the tool set digest', async () => {
    const first = await snapshotOf([plainTool('Plain', { conciseDescription: 'Short one.' })]);
    const second = await snapshotOf([plainTool('Plain', { conciseDescription: 'Short two.' })]);
    expect(descriptionOf(offered(first, true), 'Plain')).toBe('Short one.');
    expect(descriptionOf(offered(second, true), 'Plain')).toBe('Short two.');
    expect(second.digest).not.toBe(first.digest);
  });
});
