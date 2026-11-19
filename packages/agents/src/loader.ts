import { stoppedBy } from '@momonga/skills';
import type { SkillFileSystem } from '@momonga/skills';
import { scanAgents } from './scan.ts';
import { createAgentTool } from './tool.ts';
import type { AgentLoader } from './types.ts';

export type AgentLoaderOptions = { home: string; fileSystem: SkillFileSystem };

export const createAgentLoader = ({ home, fileSystem }: AgentLoaderOptions): AgentLoader => ({
  load: async ({ signal, ...request }) => {
    const { agents, warnings, pendingApproval } = await scanAgents({ home, ...request }, stoppedBy(fileSystem, signal));
    return { agents, warnings, pendingApproval, tool: (runs) => createAgentTool(agents, runs) };
  },
});
