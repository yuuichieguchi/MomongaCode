import { REASONING_EFFORTS, isReasoningEffort, sentReasoningEffort } from '@momonga/protocol';
import type { ReasoningEffort } from '@momonga/protocol';
import { acceptedEffortsOf, declaredReasoning, effortRefusalText } from '../effort.ts';
import type { SlashCommand } from '../slash.ts';

export const EFFORT_PICKER_TITLE = 'Reasoning effort';

export const effortCommand: SlashCommand = {
  name: 'effort',
  description: 'choose the reasoning effort the session asks of its model, from the next run',
  usage: `[${REASONING_EFFORTS.join('|')}]`,
  run: async (args, context) => {
    const model = context.model;
    if (model === undefined) throw new Error('/effort ran without a session model');
    const entries = await context.backend.models();
    const declared = declaredReasoning(entries, model);
    const name = context.shownModel(model);
    if (!declared.known) {
      context.info(`the capabilities of ${name} are not known yet, so its reasoning efforts are not known; use /effort again when it is ready`);
      return;
    }
    const accepted = acceptedEffortsOf(declared);
    if (accepted.length === 0) {
      context.info(effortRefusalText(name));
      return;
    }
    if (args !== '') {
      if (!isReasoningEffort(args) || !accepted.includes(args)) {
        context.info(`unknown effort ${args} for ${name}; available: ${accepted.join(', ')}`);
        return;
      }
      await context.setEffort(args);
      return;
    }
    const inForce = declared.reasoning === undefined ? undefined : sentReasoningEffort(declared.reasoning, context.effort);
    const index = await context.display.pick({
      title: EFFORT_PICKER_TITLE,
      rows: accepted.map((level) => ({ label: level })),
      initial: inForce === undefined ? 0 : Math.max(0, accepted.indexOf(inForce)),
      decideOn: 'enter',
      escape: 'back',
    });
    const chosen: ReasoningEffort | undefined = index === undefined ? undefined : accepted[index];
    if (chosen !== undefined) await context.setEffort(chosen);
  },
};
