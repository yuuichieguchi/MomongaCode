import { A11Y_SETTINGS, SWITCH_WORDS, switchWordOf } from '../screen/a11y.ts';
import { NOTIFY_MODES } from '../screen/notify.ts';
import type { SlashCommand, SlashContext } from '../slash.ts';

export const SAVING_SETTING = 'saving the setting';

type ConfigRow = {
  readonly name: string;
  readonly label: string;
  readonly values: readonly string[];
  store(context: SlashContext, value: string, signal: AbortSignal): Promise<void>;
  shown(context: SlashContext): string;
};

const notifyRow: ConfigRow = {
  name: 'notify',
  label: 'ring the terminal bell when a run ends or needs you',
  values: NOTIFY_MODES,
  store: async (context, value, signal) => {
    const chosen = NOTIFY_MODES.find((mode) => mode === value);
    if (chosen !== undefined) await context.display.storeNotify(chosen, signal);
  },
  shown: (context) => context.display.notify(),
};

const a11yRows: readonly ConfigRow[] = A11Y_SETTINGS.map(({ name, setting, label }) => ({
  name,
  label,
  values: SWITCH_WORDS,
  store: (context, value, signal) => context.display.storeA11y(setting, value === switchWordOf(true), signal),
  shown: (context) => {
    const stored = switchWordOf(context.display.storedA11y(setting));
    const inForce = switchWordOf(context.display.a11y()[setting]);
    return stored === inForce ? stored : `${stored} (${inForce} in this session)`;
  },
}));

export const CONFIG_ROWS: readonly ConfigRow[] = [notifyRow, ...a11yRows];

const usageOf = (row: ConfigRow): string => `${row.name} [${row.values.join('|')}]`;

export const CONFIG_USAGE = CONFIG_ROWS.map((row) => `/config ${usageOf(row)}`).join('\n');

export const configCommand: SlashCommand = {
  name: 'config',
  description: `show or change a setting; ${CONFIG_ROWS.map((row) => `${row.name}: ${row.label}`).join('; ')}`,
  usage: CONFIG_ROWS.map(usageOf).join(' | '),
  needsSession: false,
  run: async (args, context) => {
    const [name, value, ...rest] = args.split(/\s+/).filter((word) => word !== '');
    const row = CONFIG_ROWS.find((candidate) => candidate.name === name);
    if (row === undefined || rest.length > 0) {
      context.info(`usage: ${CONFIG_USAGE}`);
      return;
    }
    if (value === undefined) {
      context.info(`${row.name}: ${row.shown(context)}`);
      return;
    }
    if (!row.values.includes(value)) {
      context.info(`unknown ${row.name} value ${value}; available: ${row.values.join(', ')}`);
      return;
    }
    await context.background(SAVING_SETTING, (signal) => row.store(context, value, signal));
    context.info(`${row.name}: ${value}`);
  },
};
