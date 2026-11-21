import type { PickRequest } from '../picker.tsx';
import type { A11y, A11ySetting } from '../screen/a11y.ts';
import type { NotifyMode } from '../screen/notify.ts';
import { THEME_IDS } from '../screen/theme.ts';
import type { ThemeId } from '../screen/theme.ts';
import type { SlashCommand } from '../slash.ts';

export type TuiSwitch = 'mouse' | 'copyOnSelect';

export type DisplayPort = {
  theme(): ThemeId;
  previewTheme(theme: ThemeId | undefined): void;
  storeTheme(theme: ThemeId, signal: AbortSignal): Promise<void>;
  notify(): NotifyMode;
  storeNotify(mode: NotifyMode, signal: AbortSignal): Promise<void>;
  a11y(): A11y;
  storedA11y(name: A11ySetting): boolean;
  storeA11y(name: A11ySetting, value: boolean, signal: AbortSignal): Promise<void>;
  storeTui(name: TuiSwitch, value: boolean, signal: AbortSignal): Promise<void>;
  pick(request: PickRequest): Promise<number | undefined>;
};

export const THEME_PICKER_TITLE = 'Theme';
export const SAVING_THEME = 'saving the theme';

export const themeCommand: SlashCommand = {
  name: 'theme',
  description: 'choose the colours of the screen from the five built-in sets',
  usage: `[${THEME_IDS.join('|')}]`,
  subcommands: THEME_IDS.map((id) => ({ name: id, description: `switch the screen colours to ${id}` })),
  needsSession: false,
  run: async (args, context) => {
    const { display } = context;
    const store = async (theme: ThemeId): Promise<void> => {
      context.overlays.closeScreen();
      await context.background(SAVING_THEME, (signal) => display.storeTheme(theme, signal));
      context.info(`theme: ${theme}`);
    };
    if (args !== '') {
      const named = THEME_IDS.find((id) => id === args);
      if (named === undefined) context.info(`unknown theme ${args}; available: ${THEME_IDS.join(', ')}`);
      else await store(named);
      return;
    }
    try {
      const index = await display.pick({
        title: THEME_PICKER_TITLE,
        rows: THEME_IDS.map((id) => ({ label: id })),
        initial: THEME_IDS.indexOf(display.theme()),
        decideOn: 'enter',
        escape: 'back',
        onHighlight: (highlighted) => display.previewTheme(THEME_IDS[highlighted]),
      });
      const chosen = index === undefined ? undefined : THEME_IDS[index];
      if (chosen !== undefined) await store(chosen);
    } finally {
      display.previewTheme(undefined);
    }
  },
};
