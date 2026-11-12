import { describe, expect, it } from 'vitest';
import { TEST_BUILTIN_TOOL_OFFER } from '@momonga/testkit';
import type { FunctionTool } from '@momonga/protocol';
import { createBuiltinTools, createGovernanceTools, createHistoryTools, createMemoryTools, createToolRegistry, defineTool } from '@momonga/tools';
import type { AnyTool, ToolSet } from '@momonga/tools';
import { AGENT_TOOL_NAME } from '../packages/agents/src/constants.ts';
import { createAgentTool } from '../packages/agents/src/tool.ts';
import type { AgentDefinition } from '../packages/agents/src/types.ts';
import { ACTIVATE_SKILL_TOOL_NAME } from '../packages/skills/src/constants.ts';
import { createActivateSkillTool } from '../packages/skills/src/tool.ts';

const agent = (name: string, description: string): AgentDefinition => ({ name, description, prompt: `You are ${name}.`, scope: 'project', location: `/work/.momonga/agents/${name}.md` });

const AGENTS = [agent('explorer', 'Explores the repository and reports the files that matter for a question.'), agent('reviewer', 'Reviews a diff for defects and names each one.')];

const everyProductTool = (): AnyTool[] => [
  ...createBuiltinTools(TEST_BUILTIN_TOOL_OFFER),
  ...createMemoryTools({ port: {} as never, trusted: true }),
  ...createHistoryTools({ port: {} as never, trusted: true, project: '/work/a' }),
  ...createGovernanceTools({ port: {} as never, trusted: true }),
  createActivateSkillTool({
    skills: [{ name: 'deploy', description: 'Deploys the service.' }] as never,
    activate: async () => ({}) as never,
    isActive: () => false,
    admit: async () => ({}) as never,
  }),
  createAgentTool(AGENTS, { spawn: async () => ({}) as never }),
];

const snapshotOf = async (tools: readonly AnyTool[]): Promise<ToolSet> => {
  const registry = createToolRegistry();
  for (const tool of tools) registry.register(tool);
  return registry.snapshot();
};

const offeredFrom = (set: ToolSet, concise?: boolean): Map<string, FunctionTool> => {
  const options = concise === undefined ? { mode: 'manual' as const, rules: [] } : { mode: 'manual' as const, rules: [], conciseDescriptions: concise };
  return new Map(set.forModel(options).map((tool) => [tool.name, tool]));
};

const offeredOf = async (concise: boolean): Promise<Map<string, FunctionTool>> => offeredFrom(await snapshotOf(everyProductTool()), concise);

const PLAIN_DESCRIPTION = 'A plain tool with a long description that has no concise variant at all.';

const plainTool = (name: string, variant: Record<string, unknown> = {}, properties: Record<string, unknown> = {}): AnyTool =>
  ({
    ...defineTool<Record<string, never>>({
      name,
      description: PLAIN_DESCRIPTION,
      kind: 'other',
      sideEffect: 'read_only',
      inputSchema: { type: 'object', properties, additionalProperties: false },
      timeoutMs: 1000,
      title: () => name,
      subject: () => ({ kind: 'none', tool: name }),
      execute: async () => ({ status: 'completed', output: '' }),
    }),
    ...variant,
  }) as AnyTool;

const stripDescriptions = (value: unknown, key?: string): unknown => {
  if (Array.isArray(value)) return value.map((entry) => stripDescriptions(entry));
  if (value === null || typeof value !== 'object') return value;
  const insideProperties = key === 'properties';
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([name, entry]) => insideProperties || name !== 'description' || typeof entry !== 'string')
      .map(([name, entry]) => [name, stripDescriptions(entry, insideProperties ? undefined : name)]),
  );
};

const parameterDescriptionsOf = (tool: FunctionTool | undefined): Record<string, string> => {
  const properties = (tool?.parameters as { properties?: Record<string, { description?: unknown }> } | undefined)?.properties ?? {};
  return Object.fromEntries(Object.entries(properties).flatMap(([field, schema]) => (typeof schema.description === 'string' ? [[field, schema.description]] : [])));
};

const RELATIVE_PATH_FIELDS = [
  ['Read', 'file_path'],
  ['Write', 'file_path'],
  ['Edit', 'file_path'],
  ['Glob', 'path'],
  ['Grep', 'path'],
] as const;

const propertiesOf = (tool: AnyTool): string[] => Object.keys((tool.inputSchema['properties'] as Record<string, unknown> | undefined) ?? {});

const NAMES = everyProductTool().map((tool) => tool.name);

describe('the concise description contract covers every tool the product registers', () => {
  it('includes the subagent tool and the skill activation tool', () => {
    expect(NAMES).toContain(AGENT_TOOL_NAME);
    expect(NAMES).toContain(ACTIVATE_SKILL_TOOL_NAME);
  });

  it.each(NAMES)('%s has a concise description strictly shorter than its full one', async (name) => {
    const tool = everyProductTool().find((candidate) => candidate.name === name);
    expect(tool?.conciseDescription?.trim().length ?? 0).toBeGreaterThan(0);
    const full = (await offeredOf(false)).get(name)?.description ?? '';
    const concise = (await offeredOf(true)).get(name)?.description ?? '';
    expect(concise).toBe(tool?.conciseDescription);
    expect(concise.length).toBeLessThan(full.length);
  });

  it.each(NAMES)('%s gives every parameter that has a description a concise text of its own', (name) => {
    const tool = everyProductTool().find((candidate) => candidate.name === name);
    if (tool === undefined) throw new Error(`${name} is not registered`);
    const properties = (tool.inputSchema['properties'] as Record<string, { description?: unknown }> | undefined) ?? {};
    const described = propertiesOf(tool).filter((field) => typeof properties[field]?.description === 'string');
    expect(Object.keys(tool.conciseParameterDescriptions ?? {}).sort()).toEqual(described.sort());
    for (const field of described) {
      const text = tool.conciseParameterDescriptions?.[field] ?? '';
      expect(text.trim().length).toBeGreaterThan(0);
      expect(text.length).toBeLessThanOrEqual(String(properties[field]?.description).length);
    }
  });

  it('keeps the name of every subagent in the concise Agent description', async () => {
    const concise = (await offeredOf(true)).get(AGENT_TOOL_NAME)?.description ?? '';
    expect(concise).not.toBe((await offeredOf(false)).get(AGENT_TOOL_NAME)?.description);
    for (const { name } of AGENTS) expect(concise).toContain(name);
  });

  it.each(NAMES)('%s keeps the full description when concise descriptions are off or not asked for', async (name) => {
    const set = await snapshotOf(everyProductTool());
    const tool = set.get(name);
    expect(offeredFrom(set).get(name)?.description).toBe(tool?.description);
    expect(offeredFrom(set, false).get(name)?.description).toBe(tool?.description);
  });

  it('changes nothing but description strings between the two variants', async () => {
    const set = await snapshotOf(everyProductTool());
    const strip = (tools: Map<string, FunctionTool>): unknown[] => [...tools.values()].map((tool) => stripDescriptions(tool));
    expect(strip(offeredFrom(set, true))).toEqual(strip(offeredFrom(set, false)));
  });

  it.each(RELATIVE_PATH_FIELDS)('%s concise texts still say a relative %s is resolved against the working directory', async (name, field) => {
    const tool = (await offeredOf(true)).get(name);
    const concise = tool?.description ?? '';
    const fieldDescription = parameterDescriptionsOf(tool)[field] ?? '';
    for (const text of [concise, fieldDescription]) {
      expect(text).not.toMatch(/must be (an )?absolute/i);
      expect(text).not.toMatch(/^absolute/i);
      expect(text).not.toMatch(/absolute path required/i);
    }
    expect(concise).toMatch(/relative .*resolved against the working directory/i);
    expect(fieldDescription).toMatch(/relative .*resolved against the working directory/i);
  });

  it('offers the full text only for a tool that has no concise variant at all', async () => {
    const set = await snapshotOf([plainTool('Plain', {}, { field: { type: 'string', description: 'A long parameter description.' } })]);
    const tool = offeredFrom(set, true).get('Plain');
    expect(tool?.description).toBe(PLAIN_DESCRIPTION);
    expect(parameterDescriptionsOf(tool)).toEqual({ field: 'A long parameter description.' });
  });

  it('refuses to offer a tool whose concise variant leaves a described parameter without a concise text', async () => {
    const set = await snapshotOf([plainTool('Half', { conciseDescription: 'Short.' }, { field: { type: 'string', description: 'A long parameter description.' } })]);
    expect(() => offeredFrom(set, true)).toThrow(/concise variant without a concise text for parameter "field"/);
  });

  it('refuses to offer a tool whose concise variant has no concise description', async () => {
    const set = await snapshotOf([plainTool('Half', { conciseParameterDescriptions: {} })]);
    expect(() => offeredFrom(set, true)).toThrow(/concise variant without a concise description/);
  });

  it('gives the same digest to two snapshots of the same tools', async () => {
    expect((await snapshotOf(everyProductTool())).digest).toBe((await snapshotOf(everyProductTool())).digest);
  });

  it('covers the concise variant in the tool set digest', async () => {
    const first = await snapshotOf([plainTool('Plain', { conciseDescription: 'Short one.' })]);
    const second = await snapshotOf([plainTool('Plain', { conciseDescription: 'Short two.' })]);
    expect(offeredFrom(first, true).get('Plain')?.description).toBe('Short one.');
    expect(offeredFrom(second, true).get('Plain')?.description).toBe('Short two.');
    expect(second.digest).not.toBe(first.digest);
  });
});
