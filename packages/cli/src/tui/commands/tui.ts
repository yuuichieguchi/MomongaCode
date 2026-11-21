import { SCREEN_READER_KEEPS_HISTORY } from '../screen/a11y.ts';
import type { SlashCommand, SlashContext } from '../slash.ts';
import { SCREEN_MODES } from '../terminal/modes.ts';
import type { TuiSwitch } from './theme.ts';

export const APPLIES_NEXT_START = 'applies from the next start';
export const APPLIES_AT_ONCE = 'applies now';
export const SAVING_TUI_SETTING = 'saving the setting';

type Switch = { setting: TuiSwitch; label: string; applies: string };

const SWITCHES: ReadonlyMap<string, Switch> = new Map([
  ['mouse', { setting: 'mouse', label: 'Mouse', applies: APPLIES_NEXT_START }],
  ['copy-on-select', { setting: 'copyOnSelect', label: 'Copy on select', applies: APPLIES_AT_ONCE }],
]);

const SWITCH_VALUES: ReadonlyMap<string, boolean> = new Map([
  ['on', true],
  ['off', false],
]);

export const TUI_USAGE = `usage: /tui [${SCREEN_MODES.join('|')}] | /tui mouse on|off | /tui copy-on-select on|off`;

const setSwitch = async (context: SlashContext, chosen: Switch, value: boolean, word: string): Promise<void> => {
  await context.background(SAVING_TUI_SETTING, (signal) => context.display.storeTui(chosen.setting, value, signal));
  context.info(`${chosen.label}: ${word}  ${chosen.applies}`);
};

export const tuiCommand: SlashCommand = {
  name: 'tui',
  description: 'show or switch the screen mode (fullscreen, or scrollback: the terminal\'s own history), and turn the mouse or copy on select on or off',
  usage: `[${SCREEN_MODES.join('|')}|mouse on|off|copy-on-select on|off]`,
  subcommands: [
    ...SCREEN_MODES.map((mode) => ({ name: mode, description: `switch screen mode to ${mode}` })),
    {
      name: 'mouse',
      usage: 'on|off',
      description: 'turn the mouse on or off',
      subcommands: [
        { name: 'on', description: 'turn the mouse on' },
        { name: 'off', description: 'turn the mouse off' },
      ],
    },
    {
      name: 'copy-on-select',
      usage: 'on|off',
      description: 'turn copy on select on or off',
      subcommands: [
        { name: 'on', description: 'turn copy on select on' },
        { name: 'off', description: 'turn copy on select off' },
      ],
    },
  ],
  needsSession: false,
  run: async (args, context) => {
    const words = args.split(/\s+/).filter((word) => word !== '');
    const [first, second, ...rest] = words;
    if (first === undefined) {
      context.info(`screen: ${context.screen.current()}`);
      return;
    }
    const chosenSwitch = SWITCHES.get(first);
    if (chosenSwitch !== undefined) {
      const value = second === undefined ? undefined : SWITCH_VALUES.get(second);
      if (second === undefined || value === undefined || rest.length > 0) {
        context.info(TUI_USAGE);
        return;
      }
      await setSwitch(context, chosenSwitch, value, second);
      return;
    }
    const chosen = SCREEN_MODES.find((mode) => mode === first);
    if (chosen === undefined || second !== undefined) {
      context.info(`unknown screen mode ${args.trim()}; available: ${SCREEN_MODES.join(', ')}`);
      return;
    }
    if (chosen === 'fullscreen' && context.display.a11y().screenReader) {
      context.info(SCREEN_READER_KEEPS_HISTORY);
      return;
    }
    await context.screen.set(chosen);
  },
};
