import type { SlashCommand } from '../slash.ts';
import { listTemplateFiles } from './skills.ts';
import type { ListedBuiltIn, ListedFile } from './skills.ts';

export const AGENTS_TITLE = 'Agents';

export const BUILT_IN_LABEL = 'built in';

export const builtInAgentText = (name: string, description: string): string =>
  `${name} is built in, so it has no file to open. ${description} An agent file with the name ${name} replaces it.`;

export const agentsCommand: SlashCommand = {
  name: 'agents',
  description: 'list the agents, open an agent file in $EDITOR, or create one from a template',
  run: async (_args, context) => {
    const { agents, warnings } = await context.backend.agents();
    const builtIns: ListedBuiltIn[] = [];
    const files: ListedFile[] = [];
    for (const agent of agents) {
      if (agent.scope === 'builtin') builtIns.push({ name: agent.name, label: BUILT_IN_LABEL, chosen: (shown) => shown.info(builtInAgentText(agent.name, agent.description)) });
      else files.push(agent);
    }
    await listTemplateFiles(context, { title: AGENTS_TITLE, kind: 'agent', command: 'agents', builtIns, files, warnings });
  },
};
