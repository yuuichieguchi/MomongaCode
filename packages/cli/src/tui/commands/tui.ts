import type { SlashCommand } from '../slash.ts';
import { SCREEN_MODES } from '../terminal/modes.ts';

export const tuiCommand: SlashCommand = {
  name: 'tui',
  description: 'show or switch the screen mode: fullscreen, or scrollback (the terminal\'s own history)',
  usage: `/tui [${SCREEN_MODES.join('|')}]`,
  needsSession: false,
  run: async (args, context) => {
    const wanted = args.trim();
    if (wanted === '') {
      context.info(`screen: ${context.screen.current()}`);
      return;
    }
    const chosen = SCREEN_MODES.find((mode) => mode === wanted);
    if (chosen === undefined) {
      context.info(`unknown screen mode ${wanted}; available: ${SCREEN_MODES.join(', ')}`);
      return;
    }
    await context.screen.set(chosen);
  },
};
