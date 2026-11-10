import type { SlashCommand } from '../slash.ts';

export const clearCommand: SlashCommand = {
  name: 'clear',
  aliases: ['new'],
  needsSession: false,
  description: 'start a new conversation; this one stays reopenable with /resume',
  run: (_args, context) => context.sessions.startNew(),
};
