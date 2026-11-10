import { NOTIFY_MODES } from '../screen/notify.ts';
import type { SlashCommand } from '../slash.ts';

export const SAVING_SETTING = 'saving the setting';

const NOTIFY_USAGE = `/config notify [${NOTIFY_MODES.join('|')}]`;

export const configCommand: SlashCommand = {
  name: 'config',
  description: 'show or change a setting; notify: ring the terminal bell when a run ends or needs you',
  usage: `notify [${NOTIFY_MODES.join('|')}]`,
  needsSession: false,
  run: async (args, context) => {
    const { display } = context;
    const [name, value, ...rest] = args.split(/\s+/).filter((word) => word !== '');
    if (name !== 'notify' || rest.length > 0) {
      context.info(`usage: ${NOTIFY_USAGE}`);
      return;
    }
    if (value === undefined) {
      context.info(`notify: ${display.notify()}`);
      return;
    }
    const chosen = NOTIFY_MODES.find((mode) => mode === value);
    if (chosen === undefined) {
      context.info(`unknown notify value ${value}; available: ${NOTIFY_MODES.join(', ')}`);
      return;
    }
    await context.background(SAVING_SETTING, (signal) => display.storeNotify(chosen, signal));
    context.info(`notify: ${chosen}`);
  },
};
