import { formatMemory, formatMemoryList } from '../../memory/format.ts';
import type { SlashCommand } from '../slash.ts';

const USAGE = 'usage: /memory [list] | /memory show <id> | /memory delete <id> (retires the memory; it stays in momonga memory history)';

export const memoryCommand: SlashCommand = {
  name: 'memory',
  usage: '[list|show <id>|delete <id>]',
  description: 'list, show or retire the memories the agent saved',
  run: async (args, context) => {
    const [action = 'list', id, ...rest] = args.split(/\s+/).filter((part) => part !== '');
    if (rest.length > 0) {
      context.info(USAGE);
      return;
    }
    if (action === 'list' && id === undefined) {
      context.info(formatMemoryList(await context.backend.memories()));
      return;
    }
    if (action === 'show' && id !== undefined) {
      context.info(formatMemory(await context.backend.memory(id)));
      return;
    }
    if (action === 'delete' && id !== undefined) {
      await context.backend.deleteMemory(id);
      context.info(`retired memory ${id}; it stays in momonga memory history`);
      return;
    }
    context.info(USAGE);
  },
};
