import type { SlashCommand } from '../slash.ts';
import { listTemplateFiles } from './skills.ts';

export const AGENTS_TITLE = 'Agents';

export const agentsCommand: SlashCommand = {
  name: 'agents',
  description: 'list the agent files, open one in $EDITOR, or create one from a template',
  run: async (_args, context) => {
    const { agents, warnings } = await context.backend.agents();
    await listTemplateFiles(context, { title: AGENTS_TITLE, kind: 'agent', command: 'agents', files: agents, warnings });
  },
};
