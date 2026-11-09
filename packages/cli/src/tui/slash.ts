import { PERMISSION_MODES, isProbingCapabilities } from '@momonga/protocol';
import type { PermissionMode } from '@momonga/protocol';
import { selectableModes } from '../modes.ts';
import type { ModeAvailability } from '../modes.ts';
import type { AutoModeCheckOptions, AutoModeCheckOutcome, AutoModeStatusOptions, AutoModeStatusOutcome } from '../commands/auto-mode.ts';
import type { TuiBackend } from './backend.ts';

export type AutoModePort = {
  check(options: AutoModeCheckOptions, write: (text: string) => void): Promise<AutoModeCheckOutcome>;
  status(options: AutoModeStatusOptions, write: (text: string) => void): Promise<AutoModeStatusOutcome>;
};

export type ShellPort = {
  run(argv: readonly string[], io: { write(text: string): void; signal: AbortSignal }): Promise<number>;
};

export type SlashContext = ModeAvailability & {
  readonly mode: PermissionMode;
  readonly modelAlias: string | undefined;
  readonly commands: readonly SlashCommand[];
  readonly backend: TuiBackend;
  info(text: string): void;
  startRun(text: string, options?: { skill?: string }): Promise<void>;
  clear(): void;
  exit(): void;
  setMode(mode: PermissionMode): Promise<void>;
  setModel(modelAlias: string): Promise<void>;
  background<T>(label: string, work: (signal: AbortSignal) => Promise<T>): Promise<T>;
  readonly autoMode: AutoModePort;
  readonly shell: ShellPort;
};

export type SlashCommand = {
  readonly name: string;
  readonly aliases?: readonly string[];
  readonly description: string;
  readonly usage?: string;
  readonly needsSession?: boolean;
  run(args: string, context: SlashContext): Promise<void>;
};

export type SlashRegistry = {
  list(): readonly SlashCommand[];
  find(name: string): SlashCommand | undefined;
};

export const createSlashRegistry = (commands: readonly SlashCommand[]): SlashRegistry => ({
  list: () => commands,
  find: (name) => commands.find((command) => command.name === name || command.aliases?.includes(name) === true),
});

export type SlashCompletion = { names: readonly string[]; completed: string };

const COMPLETABLE = /^\/[^\s/]*$/;

const commonPrefix = (names: readonly string[]): string =>
  names.reduce((prefix, name) => {
    let length = 0;
    while (length < prefix.length && prefix[length] === name[length]) length += 1;
    return prefix.slice(0, length);
  });

export const slashCompletion = (text: string, commands: readonly SlashCommand[]): SlashCompletion | undefined => {
  if (!COMPLETABLE.test(text)) return undefined;
  const typed = text.slice(1);
  const names = commands.map((command) => command.name).filter((name) => name.startsWith(typed));
  if (names.length === 0) return undefined;
  const [only] = names;
  return { names, completed: names.length === 1 && only !== undefined ? `/${only} ` : `/${commonPrefix(names)}` };
};

export type ParsedSlash = { name: string; args: string };

export const parseSlash = (line: string): ParsedSlash | undefined => {
  const trimmed = line.trim();
  const match = /^\/([^\s/]+)(?:\s+([\s\S]*))?$/.exec(trimmed);
  if (match === null) return undefined;
  return { name: match[1] as string, args: (match[2] ?? '').trim() };
};

const help: SlashCommand = {
  name: 'help',
  needsSession: false,
  description: 'list the slash commands and key bindings',
  run: async (_args, context) => {
    context.info(
      [
        'Slash commands',
        ...context.commands.map((command) => `  /${command.name}${command.usage === undefined ? '' : ` ${command.usage}`}  ${command.description}`),
        'Keys',
        '  enter submit, backslash+enter or ctrl+j new line, up/down history',
        '  shift+tab cycle the permission mode, esc cancel the run, ctrl+d exit',
      ].join('\n'),
    );
  },
};

const clear: SlashCommand = {
  name: 'clear',
  needsSession: false,
  description: 'clear the screen and start a new conversation',
  run: async (_args, context) => {
    context.clear();
  },
};

const exit: SlashCommand = {
  name: 'exit',
  needsSession: false,
  aliases: ['quit'],
  description: 'leave momonga; a running task continues in the daemon',
  run: async (_args, context) => {
    context.exit();
  },
};

const mode: SlashCommand = {
  name: 'mode',
  usage: '[mode]',
  description: 'show or set the permission mode',
  run: async (args, context) => {
    if (args === '') {
      context.info(`permission mode: ${context.mode} (available: ${selectableModes(context).join(', ')})`);
      return;
    }
    const chosen = PERMISSION_MODES.find((candidate) => candidate === args);
    if (chosen === undefined) {
      context.info(`unknown permission mode ${args}; available: ${selectableModes(context).join(', ')}`);
      return;
    }
    await context.setMode(chosen);
  },
};

export const switchModel = async (args: string, entries: readonly { id: string }[], context: SlashContext): Promise<void> => {
  const chosen = entries.find((entry) => entry.id === args);
  if (chosen === undefined) {
    context.info(`unknown model ${args}; available: ${entries.map((entry) => entry.id).join(', ')}`);
    return;
  }
  await context.setModel(chosen.id);
};

const model: SlashCommand = {
  name: 'model',
  usage: '[alias]',
  description: 'list the model aliases with the current one marked, or switch the model from the next task',
  run: async (args, context) => {
    const entries = await context.backend.models();
    if (args === '') {
      context.info(
        [
          'models (the current one is marked *):',
          ...entries.map((entry) => `  ${entry.id === context.modelAlias ? '*' : ' '} ${entry.id}  ${isProbingCapabilities(entry.capabilities) ? entry.capabilities.toolCalling.message : `${entry.capabilities.contextWindow}-token window`}`),
          'switch with /model <alias>; a change applies from the next task',
        ].join('\n'),
      );
      return;
    }
    await switchModel(args, entries, context);
  },
};

export const BUILTIN_SLASH_COMMANDS: readonly SlashCommand[] = [help, clear, mode, model, exit];
