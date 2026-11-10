import { SCREEN_READER_KEEPS_HISTORY } from '../screen/a11y.ts';
import type { SlashCommand } from '../slash.ts';
import { SCREEN_MODES } from '../terminal/modes.ts';

export const tuiCommand: SlashCommand = {
  name: 'tui',
  description: 'show or switch the screen mode: fullscreen, or scrollback (the terminal\'s own history)',
  usage: `[${SCREEN_MODES.join('|')}]`,
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
    if (chosen === 'fullscreen' && context.display.a11y().screenReader) {
      context.info(SCREEN_READER_KEEPS_HISTORY);
      return;
    }
    await context.screen.set(chosen);
  },
};
