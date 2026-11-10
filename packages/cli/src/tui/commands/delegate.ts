import type { SlashCommand } from '../slash.ts';

export const DELEGATE_USAGE = 'usage: /delegate <mandate name> <task>   (mandates are declared in /config, under Budget and delegation)';

export const delegateCommand: SlashCommand = {
  name: 'delegate',
  usage: '<mandate> <task>',
  description: 'hand a task over under a mandate of your settings: only what it allows runs, what it asks for is held for your approval while other work goes on, and its budget bounds the run',
  run: async (args, context) => {
    if (context.refusedWhileRunning()) return;
    const [name = '', ...words] = args.trim().split(/\s+/);
    const task = words.join(' ');
    if (name === '' || task === '') {
      context.info(DELEGATE_USAGE);
      return;
    }
    await context.startRun(task, { mandate: { profile: name } });
  },
};
