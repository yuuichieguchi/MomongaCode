import type { SlashCommand } from '../slash.ts';
import { runShellCommand } from './shell-commands.ts';

export const NO_RUN_TO_REPORT = 'This session has no run yet, so there is no report to show.';

export const reportCommand: SlashCommand = {
  name: 'report',
  needsSession: false,
  usage: '[run-id] [--json]',
  description:
    'show the verification report of a run: the declared completion conditions, what passed, failed or was not run, and the residual risk; the current or last run of this session when no id is given',
  run: async (args, context) => {
    const tokens = args.split(/\s+/).filter((part) => part !== '');
    if (tokens.some((token) => !token.startsWith('--'))) {
      await runShellCommand('report', args, context);
      return;
    }
    const latest = (await context.backend.runs()).at(-1);
    if (latest === undefined) {
      context.info(NO_RUN_TO_REPORT);
      return;
    }
    await runShellCommand('report', `${latest.id} ${args}`, context);
  },
};
