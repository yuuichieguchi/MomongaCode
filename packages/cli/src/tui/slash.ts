import { PERMISSION_MODES, isNotListedCapabilities, notListedMessage } from '@momonga/protocol';
import type { PermissionMode } from '@momonga/protocol';
import { selectableModes } from '../modes.ts';
import type { ModeAvailability } from '../modes.ts';
import type { AutoModeCheckOptions, AutoModeCheckOutcome, AutoModeStatusOptions, AutoModeStatusOutcome } from '../commands/auto-mode.ts';
import type { DisplayPort } from './commands/theme.ts';
import type { TuiBackend } from './backend.ts';
import type { ActionId, KeyContext, KeySpec, KeyTable } from './keys/table.ts';
import { NEWLINE_HINT } from './terminal/negotiation.ts';
import type { NegotiationState } from './terminal/negotiation.ts';
import type { ScreenMode } from './terminal/modes.ts';

export type AutoModePort = {
  check(options: AutoModeCheckOptions, write: (text: string) => void): Promise<AutoModeCheckOutcome>;
  status(options: AutoModeStatusOptions, write: (text: string) => void): Promise<AutoModeStatusOutcome>;
};

export type ShellPort = {
  run(argv: readonly string[], io: { write(text: string): void; signal: AbortSignal }): Promise<number>;
};

export type ScreenPort = { current(): ScreenMode; set(mode: ScreenMode): Promise<void> };

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
  readonly screen: ScreenPort;
  readonly keys: KeyTable;
  readonly negotiation: NegotiationState;
  readonly display: DisplayPort;
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

export type ParsedSlash = { name: string; args: string };

export const parseSlash = (line: string): ParsedSlash | undefined => {
  const trimmed = line.trim();
  const match = /^\/([^\s/]+)(?:\s+([\s\S]*))?$/.exec(trimmed);
  if (match === null) return undefined;
  return { name: match[1] as string, args: (match[2] ?? '').trim() };
};

const NEWLINE: ActionId = 'prompt.newline';
const NEEDS_REPORT = /(^|\+)shift\+/;
const SENT_AS_ESCAPE = /(^|\+)alt\+/;
const KEY_JOIN = ' or ';
const HELP_CONTEXTS: Readonly<Record<ScreenMode, readonly KeyContext[]>> = { fullscreen: ['chat', 'viewport', 'global'], scrollback: ['chat', 'global'] };
const MOUSE_HELP: Readonly<Record<ScreenMode, readonly string[]>> = {
  fullscreen: ['wheel: scroll', 'drag: select', 'double click: select a word', 'triple click: select a line', 'click on a link: open it', 'click in the input: place the caret', 'click on a menu row: complete it'],
  scrollback: [],
};

export const newlineHelpLines = (keys: KeyTable, negotiation: NegotiationState): string[] => {
  const description = keys.rows().find((row) => row.id === NEWLINE)?.description;
  const reported = NEWLINE_HINT[negotiation] === 'shift+enter';
  const all = keys.keysFor(NEWLINE);
  const escaped = all.filter((spec) => SENT_AS_ESCAPE.test(spec));
  const direct = all.filter((spec) => !SENT_AS_ESCAPE.test(spec));
  const unproven = reported ? [] : direct.filter((spec) => NEEDS_REPORT.test(spec));
  const acting = (spec: KeySpec): boolean => direct.includes(spec) && !unproven.includes(spec);
  return [
    `${keys.hintFor(NEWLINE, acting)}: ${description}${unproven.length === 0 ? '' : ` (${unproven.join(KEY_JOIN)} works only if this terminal reports it; this one has not)`}`,
    ...escaped.map((spec) => `${spec}: ${description} where the terminal sends Alt as Escape`),
    `\\ then ${keys.hintFor('prompt.submit')}: ${description}`,
  ];
};

export type HelpFacts = { commands: readonly SlashCommand[]; keys: KeyTable; negotiation: NegotiationState; screen: ScreenMode };

const indented = (lines: readonly string[]): string[] => lines.map((line) => `  ${line}`);

export const helpText = ({ commands, keys, negotiation, screen }: HelpFacts): string => {
  const contexts = HELP_CONTEXTS[screen];
  const keyLines = keys
    .rows()
    .filter((row) => contexts.includes(row.context))
    .flatMap((row) => (row.id === NEWLINE ? newlineHelpLines(keys, negotiation) : [`${keys.hintFor(row.id)}: ${row.description}`]));
  const mouse = MOUSE_HELP[screen];
  return [
    'Commands',
    ...indented(commands.map((command) => `/${command.name}${command.usage === undefined ? '' : ` ${command.usage}`}  ${command.description}`)),
    'Keys',
    ...indented(keyLines),
    ...(mouse.length === 0 ? [] : ['Mouse', ...indented(mouse)]),
  ].join('\n');
};

const help: SlashCommand = {
  name: 'help',
  needsSession: false,
  description: 'list the commands, the keys and the mouse actions',
  run: async (_args, context) => {
    context.info(helpText({ commands: context.commands, keys: context.keys, negotiation: context.negotiation, screen: context.screen.current() }));
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
          ...entries.map((entry) => `  ${entry.id === context.modelAlias ? '*' : ' '} ${entry.id}  ${isNotListedCapabilities(entry.capabilities) ? notListedMessage(entry.capabilities) : `${entry.capabilities.contextWindow}-token window`}`),
          'switch with /model <alias>; a change applies from the next task',
        ].join('\n'),
      );
      return;
    }
    await switchModel(args, entries, context);
  },
};

export const BUILTIN_SLASH_COMMANDS: readonly SlashCommand[] = [help, clear, mode, model, exit];
