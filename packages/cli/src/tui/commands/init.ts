import type { SlashCommand } from '../slash.ts';

export const initCommand: SlashCommand = {
  name: 'init',
  description: 'create AGENTS.md for this project from what the repository shows, or improve the one it has',
  run: async (_args, context) => {
    if (context.refusedWhileRunning()) return;
    await context.startRun(await context.backend.initInstruction());
  },
};
