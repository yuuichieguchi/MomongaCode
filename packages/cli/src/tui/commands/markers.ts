import type { SlashCommand } from '../slash.ts';

const USAGE = 'usage: /markers ignore <marker name>';

const IGNORE = /^ignore\s+(\S+)$/;

export const markersCommand: SlashCommand = {
  name: 'markers',
  usage: 'ignore <marker name>',
  description: 'tell MomongaCode to stop blocking calls because of a process an earlier command left running',
  subcommands: [{ name: 'ignore', usage: '<marker name>', description: 'ignore one marker in the guard' }],
  run: async (args, context) => {
    const ignored = IGNORE.exec(args.trim());
    if (ignored === null) {
      context.info(USAGE);
      return;
    }
    const [, name = ''] = ignored;
    try {
      await context.backend.ignoreMarker(name);
    } catch (error) {
      context.info(error instanceof Error ? error.message : String(error));
      return;
    }
    context.info(`marker ${name} is ignored by the guard; the sweeps still remove it once it is free`);
  },
};
