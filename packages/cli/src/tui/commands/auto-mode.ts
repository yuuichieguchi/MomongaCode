import { describeFailure } from '../../failure.ts';
import { runClassifierFlow } from '../models/order.ts';
import type { SlashCommand } from '../slash.ts';

const READING_MEASUREMENT_PHASE = 'reading the stored measurement';

const USAGE = 'usage: /auto-mode | /auto-mode check [<model>] [--agent <model>] | /auto-mode status [<model>]';

type Parsed = { classifier?: string; agent?: string };

const parsedOf = (tokens: readonly string[]): Parsed | undefined => {
  const parsed: Parsed = {};
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] as string;
    if (token === '--agent') {
      const value = tokens[index + 1];
      if (value === undefined || value.startsWith('--') || parsed.agent !== undefined) return undefined;
      parsed.agent = value;
      index += 1;
    } else if (token.startsWith('--') || parsed.classifier !== undefined) {
      return undefined;
    } else {
      parsed.classifier = token;
    }
  }
  return parsed;
};

export const autoModeCommand: SlashCommand = {
  name: 'auto-mode',
  usage: '[check [<model>] [--agent <model>] | status [<model>]]',
  description: 'choose the model that judges approvals for auto mode, measure how well a model judges them, or show the stored measurement',
  subcommands: [
    { name: 'check', usage: '[<model>] [--agent <model>]', description: 'measure how well a model judges approvals for auto mode' },
    { name: 'status', usage: '[<model>]', description: 'show the stored measurement' },
  ],
  run: async (args, context) => {
    if (args.trim() === '') {
      await runClassifierFlow(context);
      return;
    }
    const [action, ...rest] = args.split(/\s+/).filter((part) => part !== '');
    const parsed = parsedOf(rest);
    if (parsed === undefined || (action !== 'check' && action !== 'status') || (action === 'status' && parsed.agent !== undefined)) {
      context.info(USAGE);
      return;
    }
    const classifier = parsed.classifier === undefined ? {} : { classifier: parsed.classifier };
    if (action === 'status') {
      await context.wait(READING_MEASUREMENT_PHASE, (signal) => context.autoMode.status({ ...classifier, surface: 'tui', signal }, context.info));
      return;
    }
    const agent = parsed.agent ?? context.model;
    if (agent === undefined) throw new Error('the auto-mode check needs a session with a model');
    context
      .background('auto-mode check', (signal) => context.autoMode.check({ ...classifier, agent, signal }, context.info))
      .then(
        () => undefined,
        (error: unknown) => context.info(`auto-mode check stopped: ${describeFailure(error)}`),
      );
  },
};
