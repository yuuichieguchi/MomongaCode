import type { SlashCommand } from '../slash.ts';
import { runShellCommand } from './shell-commands.ts';

export const reportCommand: SlashCommand = {
  name: 'report',
  needsSession: false,
  usage: '[run-id] [--json]',
  description:
    'show the verification report of a run: the declared completion conditions, what passed, failed or was not run, and the residual risk; the latest run of this folder when no id is given, as momonga report',
  run: async (args, context) => {
    await runShellCommand('report', args, context);
  },
};
