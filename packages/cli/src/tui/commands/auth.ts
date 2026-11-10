import type { PlanFlows } from '../plan-flows.ts';
import { switchModel } from '../slash.ts';
import type { SlashCommand } from '../slash.ts';

export const planSlashCommands = (flows: PlanFlows): readonly SlashCommand[] => [
  {
    name: 'login',
    usage: '[provider]',
    description: 'connect a model: sign in to a subscription, add an API key or a local server',
    needsSession: false,
    run: (args) => flows.login(args),
  },
  {
    name: 'logout',
    description: 'sign out a saved subscription account',
    needsSession: false,
    run: () => flows.logout(),
  },
];

export const modelPickerCommand = (flows: PlanFlows): SlashCommand => ({
  name: 'model',
  usage: '[alias]',
  description: 'choose the model from a list, or switch to an alias from the next task',
  needsSession: false,
  run: async (args, context) => {
    if (args === '') {
      await flows.modelPicker(context.modelAlias);
      return;
    }
    await switchModel(args, await context.backend.models(), context);
  },
});
