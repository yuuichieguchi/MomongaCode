import type { SkillFileSystem } from '@momonga/skills';
import { scanAgents } from './scan.ts';
import { createAgentTool } from './tool.ts';
import type { AgentLoader } from './types.ts';

export type AgentLoaderOptions = { home: string; fileSystem: SkillFileSystem };

export const createAgentLoader = ({ home, fileSystem }: AgentLoaderOptions): AgentLoader => ({
  load: async (request) => {
    const { agents, warnings, pendingApproval } = await scanAgents({ home, ...request }, fileSystem);
    return { agents, warnings, pendingApproval, tool: (runs) => (agents.length === 0 ? undefined : createAgentTool(agents, runs)) };
  },
});
