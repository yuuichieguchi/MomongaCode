import type { SkillFileSystem } from '@momonga/skills';
import { scanAgents } from './scan.ts';
import { createAgentTool } from './tool.ts';
import type { AgentLoader } from './types.ts';

export type AgentLoaderOptions = { home: string; fileSystem: SkillFileSystem };

export const createAgentLoader = ({ home, fileSystem }: AgentLoaderOptions): AgentLoader => ({
  load: async ({ projectRoot, trusted }) => {
    const { agents, warnings } = await scanAgents({ home, projectRoot, trusted }, fileSystem);
    return { agents, warnings, tool: (runs) => (agents.length === 0 ? undefined : createAgentTool(agents, runs)) };
  },
});
