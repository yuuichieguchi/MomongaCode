import { describe, expect, it } from 'vitest';
import type { FunctionTool } from '@momonga/protocol';
import { createBuiltinTools, createGovernanceTools, createHistoryTools, createMemoryTools, createToolRegistry } from '@momonga/tools';
import type { AnyTool } from '@momonga/tools';
import { AGENT_TOOL_NAME } from '../packages/agents/src/constants.ts';
import { createAgentTool } from '../packages/agents/src/tool.ts';
import type { AgentDefinition } from '../packages/agents/src/types.ts';
import { ACTIVATE_SKILL_TOOL_NAME } from '../packages/skills/src/constants.ts';
import { createActivateSkillTool } from '../packages/skills/src/tool.ts';

const agent = (name: string, description: string): AgentDefinition => ({ name, description, prompt: `You are ${name}.`, scope: 'project', location: `/work/.momonga/agents/${name}.md` });

const AGENTS = [agent('explorer', 'Explores the repository and reports the files that matter for a question.'), agent('reviewer', 'Reviews a diff for defects and names each one.')];

const everyProductTool = (): AnyTool[] => [
  ...createBuiltinTools(),
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

const offeredOf = async (concise: boolean): Promise<Map<string, FunctionTool>> => {
  const registry = createToolRegistry();
  for (const tool of everyProductTool()) registry.register(tool);
  const set = await registry.snapshot();
  return new Map(set.forModel({ mode: 'default', rules: [], conciseDescriptions: concise }).map((tool) => [tool.name, tool]));
};

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
});