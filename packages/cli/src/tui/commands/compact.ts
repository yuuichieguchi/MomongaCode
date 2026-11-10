import type { SlashCommand } from '../slash.ts';

export const compactCommand: SlashCommand = {
  name: 'compact',
  usage: '[instructions]',
  description: 'compact the conversation now; the text after the command is what the summary should focus on',
  run: async (args, context) => {
    if (context.refusedWhileRunning()) return;
    await context.compact(args === '' ? undefined : args);
  },
};
