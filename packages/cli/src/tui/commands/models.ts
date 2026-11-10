import { runAddFlow } from '../models/add.ts';
import { runModelsHub, runProgramsFlow } from '../models/hub.ts';
import { runBillingFlow, runFallbackFlow, runRoleFlow, runStartFlow, runTimeoutsFlow } from '../models/order.ts';
import type { SlashCommand, SlashContext } from '../slash.ts';
import { shellFormOf } from './shell-commands.ts';

type Flow = (context: SlashContext) => Promise<unknown>;

export const MODELS_FLOWS: Readonly<Record<string, Flow>> = {
  'add': runAddFlow,
  'start': runStartFlow,
  'fallback': runFallbackFlow,
  'billing': runBillingFlow,
  'role': runRoleFlow,
  'timeouts': runTimeoutsFlow,
  'programs': runProgramsFlow,
};

export const MODELS_USAGE = `[${Object.keys(MODELS_FLOWS).join(' | ')}]`;

export const modelsCommand: SlashCommand = {
  name: 'models',
  usage: MODELS_USAGE,
  description: 'see and change the configured models: add or remove a model or a server, the model of new sessions, the fallback models, the billing changes, the models of other jobs and the wait limits',
  needsSession: false,
  run: async (args, context) => {
    const flow = args === '' ? runModelsHub : Object.hasOwn(MODELS_FLOWS, args) ? MODELS_FLOWS[args] : undefined;
    if (flow === undefined) {
      await shellFormOf('models').run(args, context);
      return;
    }
    await flow(context);
    await context.refreshConnection();
  },
};
