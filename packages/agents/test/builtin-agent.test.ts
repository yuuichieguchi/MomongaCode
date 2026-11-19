import { describe, expect, it } from 'vitest';
import type { DirectoryEntry, SkillFileSystem } from '@momonga/skills';
import { GENERAL_PURPOSE_AGENT, createAgentLoader } from '@momonga/agents';
import type { ChildRunRequest, ProjectAgentApproved } from '@momonga/agents';
import type { ToolContext } from '@momonga/tools';

const HOME = '/home/u';
const PROJECT = '/work/app';
const PROJECT_AGENTS = `${PROJECT}/.momonga/agents`;
const HOME_AGENTS = `${HOME}/.momonga/agents`;

const fileSystemOf = (files: Readonly<Record<string, string>>): SkillFileSystem => ({
  listDirectory: async (directory): Promise<DirectoryEntry[] | undefined> => {
    const names = Object.keys(files)
      .filter((file) => file.startsWith(`${directory}/`) && !file.slice(directory.length + 1).includes('/'))
      .map((file) => ({ name: file.slice(directory.length + 1), kind: 'file' as const }));
    return names.length === 0 ? undefined : names;
  },
  readText: async (file) => files[file],
  realpath: async (target) => target,
});

const agentFile = (name: string, description: string): string => `---\nname: ${name}\ndescription: ${description}\n---\nDo the work.\n`;

const load = (files: Record<string, string>, options: { trusted?: boolean; approved?: ProjectAgentApproved } = {}) =>
  createAgentLoader({ home: HOME, fileSystem: fileSystemOf(files) }).load({
    projectRoot: PROJECT,
    trusted: options.trusted ?? true,
    projectAgentApproved: options.approved ?? (() => true),
    signal: new AbortController().signal,
  });

describe('the built-in general-purpose agent', () => {
  it('is defined like a file definition with no tools line and the model of the parent', () => {
    expect(GENERAL_PURPOSE_AGENT.name).toBe('general-purpose');
    expect(GENERAL_PURPOSE_AGENT.scope).toBe('builtin');
    expect(GENERAL_PURPOSE_AGENT.description).not.toBe('');
    expect(GENERAL_PURPOSE_AGENT.prompt).toContain('final message');
    expect(GENERAL_PURPOSE_AGENT).not.toHaveProperty('tools');
    expect(GENERAL_PURPOSE_AGENT).not.toHaveProperty('model');
    expect(GENERAL_PURPOSE_AGENT).not.toHaveProperty('location');
  });

  it('is the one agent when no definition file exists, and the Agent tool is offered for it', async () => {
    const set = await load({});
    expect(set.agents).toEqual([GENERAL_PURPOSE_AGENT]);
    expect(set.warnings).toEqual([]);
    const tool = set.tool({ spawn: async () => ({ state: 'running', runId: 'c', sessionId: 's' }) });
    expect(tool.inputSchema).toMatchObject({ properties: { subagent_type: { enum: ['general-purpose'] } } });
    expect(tool.description).toContain(`- general-purpose: ${GENERAL_PURPOSE_AGENT.description}`);
  });

  it('spawns a child with its own prompt and the tools a definition without a tools line gets', async () => {
    const requests: ChildRunRequest[] = [];
    const tool = (await load({})).tool({
      spawn: async (request) => {
        requests.push(request);
        return { state: 'running', runId: 'child', sessionId: 'cs' };
      },
    });
    const context = { runId: 'run-1', callId: 'call-1', deadlineAt: 99 } as ToolContext;
    expect(await tool.execute({ description: 'd', prompt: 'Find the parser', subagent_type: 'general-purpose' }, context, undefined)).toMatchObject({ status: 'pending', awaits: { agent: 'general-purpose' } });
    expect(requests).toEqual([{ parentRunId: 'run-1', parentCallId: 'call-1', agent: GENERAL_PURPOSE_AGENT, prompt: 'Find the parser' }]);
    expect(requests[0]?.agent.tools).toBeUndefined();
    expect(requests[0]?.agent.model).toBeUndefined();
  });

  it('comes first, before the agents of the files by name', async () => {
    const set = await load({ [`${HOME_AGENTS}/zeta.md`]: agentFile('zeta', 'Z'), [`${PROJECT_AGENTS}/alpha.md`]: agentFile('alpha', 'A') });
    expect(set.agents.map((agent) => agent.name)).toEqual(['general-purpose', 'alpha', 'zeta']);
    const tool = set.tool({ spawn: async () => ({ state: 'running', runId: 'c', sessionId: 's' }) });
    expect(tool.inputSchema).toMatchObject({ properties: { subagent_type: { enum: ['general-purpose', 'alpha', 'zeta'] } } });
  });

  it('is replaced by a home definition of the same name, which keeps the first place, with no warning', async () => {
    const set = await load({ [`${HOME_AGENTS}/gp.md`]: agentFile('general-purpose', 'Mine'), [`${HOME_AGENTS}/a.md`]: agentFile('a', 'A') });
    expect(set.agents).toMatchObject([{ name: 'general-purpose', description: 'Mine', scope: 'user', location: `${HOME_AGENTS}/gp.md` }, { name: 'a' }]);
    expect(set.warnings).toEqual([]);
  });

  it('is replaced by a project definition only once it is approved, and stands in while it waits', async () => {
    const files = { [`${PROJECT_AGENTS}/gp.md`]: agentFile('general-purpose', 'Ours') };
    const waiting = await load(files, { approved: () => false });
    expect(waiting.agents).toEqual([GENERAL_PURPOSE_AGENT]);
    expect(waiting.pendingApproval).toMatchObject([{ name: 'general-purpose', source: `${PROJECT_AGENTS}/gp.md` }]);
    const approved = await load(files);
    expect(approved.agents).toMatchObject([{ name: 'general-purpose', description: 'Ours', scope: 'project' }]);
  });

  it('stands in for a waiting project definition even when the home holds one of the same name', async () => {
    const set = await load({ [`${PROJECT_AGENTS}/gp.md`]: agentFile('general-purpose', 'Ours'), [`${HOME_AGENTS}/gp.md`]: agentFile('general-purpose', 'Mine') }, { approved: () => false });
    expect(set.agents).toEqual([GENERAL_PURPOSE_AGENT]);
  });

  it('is the one in use when the project definition of an untrusted folder is skipped', async () => {
    const set = await load({ [`${PROJECT_AGENTS}/gp.md`]: agentFile('general-purpose', 'Ours') }, { trusted: false });
    expect(set.agents).toEqual([GENERAL_PURPOSE_AGENT]);
  });
});
