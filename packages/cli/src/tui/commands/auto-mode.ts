import { describeFailure } from '../../failure.ts';
import type { SlashCommand } from '../slash.ts';

const USAGE = 'usage: /auto-mode check [<alias>] [--agent <alias>] | /auto-mode status [<alias>]';

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
  usage: 'check [<alias>] [--agent <alias>] | status [<alias>]',
  description: 'measure how well a model judges approvals for auto mode, or show the stored measurement',
  run: async (args, context) => {
    const [action, ...rest] = args.split(/\s+/).filter((part) => part !== '');
    const parsed = parsedOf(rest);
    if (parsed === undefined || (action !== 'check' && action !== 'status') || (action === 'status' && parsed.agent !== undefined)) {
      context.info(USAGE);
      return;
    }
    const classifier = parsed.classifier === undefined ? {} : { classifier: parsed.classifier };
    if (action === 'status') {
      await context.autoMode.status({ ...classifier, surface: 'tui' }, context.info);
      return;
    }
    const agent = parsed.agent ?? context.modelAlias;
    if (agent === undefined) throw new Error('the auto-mode check needs a session with a model alias');
    context
      .background('auto-mode check', (signal) => context.autoMode.check({ ...classifier, agent, signal }, context.info))
      .then(
        () => undefined,
        (error: unknown) => context.info(`auto-mode check stopped: ${describeFailure(error)}`),
      );
  },
};
