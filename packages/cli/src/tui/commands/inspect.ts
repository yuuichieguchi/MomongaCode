import type { SlashCommand } from '../slash.ts';

export const inspectCommand: SlashCommand = {
  name: 'inspect',
  description: 'Open agent inspector',
  run: async (arg, context) => {
    const trimmed = arg.trim();
    context.openInspector?.(trimmed === '' ? undefined : trimmed);
  },
};
