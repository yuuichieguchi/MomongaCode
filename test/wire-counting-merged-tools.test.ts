import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createAgentLoader } from '@momonga/agents';
import { PinnedOverflowError, createFsInstructionReader, createTokenMeter, inputCeilingFor, measurePinned } from '@momonga/context';
import type { BuildContextInput } from '@momonga/context';
import { createChatCompletionsAdapter, wireTokensOf } from '@momonga/gateway';
import type { AnyTool } from '@momonga/tools';
import type { AdapterRequest, Capabilities, FunctionTool } from '@momonga/protocol';
import { buildSystemPrompt } from '@momonga/runtime';
import { createNodeSkillFileSystem, createSkillLoader } from '@momonga/skills';
import { createBuiltinTools, createMemoryTools, createToolRegistry } from '@momonga/tools';
import { createFakeClock } from '@momonga/testkit';

const CAPABILITIES: Capabilities = {
  contextWindow: 4096,
  maxOutputTokens: 1024,
  toolCalling: 'constrained',
  structuredOutput: 'json_schema',
  streaming: true,
  stopSequences: false,
  imageInput: false,
  parallelToolCalls: true,
  schemaDialect: 'json-schema-2020-12',
  tokenCounting: 'estimated',
  usageReported: true,
  maxConcurrency: 1,
  source: 'config',
};

const TARGET = { name: 'fm', model: 'system' };
const TASK = 'Search the haystack';

const adapter = createChatCompletionsAdapter({
  resolveEndpoint: async () => ({ kind: 'unix', socketPath: '/nonexistent/never-used.sock' }),
  toolCalling: () => 'constrained',
  capabilities: async () => CAPABILITIES,
  clock: createFakeClock(0),
});

const temporaryRoots: string[] = [];

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

const unusedMemoryPort = {
  save: (): never => {
    throw new Error('the memory port is not used while measuring');
  },
  search: (): never => {
    throw new Error('the memory port is not used while measuring');
  },
};

const unusedChildRuns = {
  spawn: (): never => {
    throw new Error('child runs are not used while measuring');
  },
};

const defineWorkspace = async (): Promise<{ home: string; project: string }> => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'momonga-merged-tools-'));
  temporaryRoots.push(root);
  const home = path.join(root, 'home');
  const project = path.join(root, 'project');
  await fs.mkdir(path.join(project, '.momonga', 'skills', 'review'), { recursive: true });
  await fs.mkdir(path.join(project, '.momonga', 'agents'), { recursive: true });
  await fs.mkdir(home, { recursive: true });
  await fs.writeFile(path.join(project, '.momonga', 'skills', 'review', 'SKILL.md'), '---\nname: review\ndescription: Review a change\n---\nReview it.\n');
  await fs.writeFile(path.join(project, '.momonga', 'agents', 'explorer.md'), '---\nname: explorer\ndescription: Explore the code\n---\nExplore it.\n');
  return { home, project };
};

type Assembly = { tools: FunctionTool[]; skillCatalog: string | undefined; home: string; project: string };

const assemble = async (options: { withSkillsAndAgents: boolean; withJobs: boolean }): Promise<Assembly> => {
  const additional: AnyTool[] = [];
  let skillCatalog: string | undefined;
  const { home, project } = await defineWorkspace();
  if (options.withSkillsAndAgents) {
    const skills = await createSkillLoader({ home, fileSystem: createNodeSkillFileSystem() }).load({ projectRoot: project, trusted: true });
    skillCatalog = skills.catalog;
    const activation = skills.activationTool({ isActive: () => false });
    if (activation !== undefined) additional.push(activation);
    const agents = await createAgentLoader({ home, fileSystem: createNodeSkillFileSystem() }).load({ projectRoot: project, trusted: true });
    const agentTool = agents.tool(unusedChildRuns);
    if (agentTool !== undefined) additional.push(agentTool);
  }
  additional.push(...createMemoryTools({ port: unusedMemoryPort, trusted: true }));
  const registry = createToolRegistry();
  for (const tool of createBuiltinTools()) registry.register(tool);
  for (const tool of additional) registry.register(tool);
  const snapshot = await registry.snapshot();
  return { tools: snapshot.forModel({ mode: 'default', rules: [], jobs: options.withJobs }), skillCatalog, home, project };
};

const systemPrompt = buildSystemPrompt({ cwd: '/private/tmp/momonga-e2e-xxxxxxxx/project', platform: 'darwin' });

const meter = createTokenMeter({
  model: 'system',
  capabilities: CAPABILITIES,
  counter: {
    count: async (request) => {
      const wireRequest: AdapterRequest = {
        model: request.model,
        input: request.input as AdapterRequest['input'],
        ...(request.tools === undefined ? {} : { tools: request.tools }),
        tool_choice: 'auto',
      };
      return { input_tokens: wireTokensOf(adapter.renderWire?.(wireRequest, TARGET) as never), method: 'estimated', error_bound: 0 };
    },
  },
});

const pinnedInput = (assembly: Assembly): BuildContextInput => ({
  capabilities: CAPABILITIES,
  model: 'system',
  sources: {
    systemPrompt,
    tools: assembly.tools,
    task: { type: 'message', role: 'user', content: [{ type: 'input_text', text: TASK }] },
    taskSeq: 1,
    ...(assembly.skillCatalog === undefined ? {} : { skillCatalog: assembly.skillCatalog }),
    activatedSkills: [],
    history: [],
  },
  evicted: new Set(),
  touchedPaths: [],
  trusted: false,
  projectRoot: assembly.project,
  home: assembly.home,
  level: 0,
});

const instructions = createFsInstructionReader();

const blobs = {
  handleFor: (): never => {
    throw new Error('blobs are not used while measuring the pinned prefix');
  },
  put: (): never => {
    throw new Error('blobs are not used while measuring the pinned prefix');
  },
};

const overflowOf = async (assembly: Assembly): Promise<PinnedOverflowError> => {
  const outcome: unknown = await measurePinned(pinnedInput(assembly), { meter, blobs, instructions }).catch((error: unknown) => error);
  if (outcome instanceof PinnedOverflowError) return outcome;
  if (outcome instanceof Error) throw outcome;
  throw new Error(`the pinned prefix fit: ${JSON.stringify(outcome)}`);
};

describe('wire counting for the merged default tool set at fm\'s window', () => {
  it('lists the builtin tools and the memory tools, with the job tools hidden until a job exists', async () => {
    const assembly = await assemble({ withSkillsAndAgents: false, withJobs: false });
    expect(assembly.tools.map((tool) => tool.name)).toEqual(['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'ReadOutput', 'UpdatePlan', 'MemorySave', 'MemorySearch']);
  });

  it('cannot start a run: the pinned prefix needs 3773 tokens where at most 2300 fit', async () => {
    const error = await overflowOf(await assemble({ withSkillsAndAgents: false, withJobs: false }));
    expect({ pinnedTokens: error.pinnedTokens, ceiling: error.ceiling, breakdown: error.breakdown }).toEqual({
      pinnedTokens: 3773,
      ceiling: 2300,
      breakdown: { systemPrompt: 292, tools: 3480, instructions: 0, task: 16 },
    });
    expect(inputCeilingFor(CAPABILITIES)).toBe(2300);
  });

  it('cannot start a run either with a skill, an agent and the job tools all surfaced', async () => {
    const assembly = await assemble({ withSkillsAndAgents: true, withJobs: true });
    expect(assembly.tools.map((tool) => tool.name)).toEqual([
      'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'BashOutput', 'KillBash', 'ReadOutput', 'UpdatePlan', 'activate_skill', 'Agent', 'MemorySave', 'MemorySearch',
    ]);
    const error = await overflowOf(assembly);
    expect({ pinnedTokens: error.pinnedTokens, ceiling: error.ceiling, breakdown: error.breakdown }).toEqual({
      pinnedTokens: 4746,
      ceiling: 2300,
      breakdown: { systemPrompt: 292, tools: 4368, instructions: 96, task: 16 },
    });
  });
});
