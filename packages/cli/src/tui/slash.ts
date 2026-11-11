import { ModelRefError, PERMISSION_MODES, displayMapOf, isNotListedCapabilities, notListedMessage } from '@momonga/protocol';
import type { Mandate, MomongaModelEntry, PermissionMode } from '@momonga/protocol';
import { listingViewsOf } from '../client/gateway-client.ts';
import { listedModelOf } from '../commands/models.ts';
import { selectableModes } from '../modes.ts';
import type { ModeAvailability } from '../modes.ts';
import type { AutoModeCheckOptions, AutoModeCheckOutcome, AutoModeStatusOptions, AutoModeStatusOutcome } from '../commands/auto-mode.ts';
import type { DisplayPort } from './commands/theme.ts';
import type { TuiBackend } from './backend.ts';
import { keyReported, needsReport, sentAsEscape, shownKey } from './keys/table.ts';
import type { ActionId, KeyContext, KeySpec, KeyTable } from './keys/table.ts';
import type { KeyBindingsScreen } from './commands/keybindings.ts';
import type { FoundServers } from './models/context.ts';
import { writeStart } from './models/order.ts';
import { startingModelSetText } from './models/texts.ts';
import type { OverlayPorts } from './picker.tsx';
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

export type SessionsPort = { startNew(): Promise<void>; resume(id: string): Promise<void>; now(): number; columns(): number };

export type SlashContext = ModeAvailability & {
  readonly mode: PermissionMode;
  readonly model: string | undefined;
  readonly found: FoundServers;
  wait<T>(phase: string, work: (signal: AbortSignal) => Promise<T>): Promise<T>;
  toast(text: string): void;
  refreshConnection(): Promise<void>;
  readonly commands: readonly SlashCommand[];
  readonly backend: TuiBackend;
  info(text: string): void;
  startRun(text: string, options?: { skill?: string; mandate?: Mandate }): Promise<void>;
  compact(instructions: string | undefined): Promise<void>;
  exit(): void;
  setMode(mode: PermissionMode): Promise<void>;
  setModel(model: string): Promise<void>;
  background<T>(label: string, work: (signal: AbortSignal) => Promise<T>): Promise<T>;
  readonly autoMode: AutoModePort;
  readonly shell: ShellPort;
  readonly screen: ScreenPort;
  readonly keys: KeyTable;
  readonly negotiation: NegotiationState;
  readonly display: DisplayPort;
  readonly keyBindings: KeyBindingsScreen;
  readonly overlays: Pick<OverlayPorts, 'choose' | 'promptText'>;
  refusedWhileRunning(): boolean;
  status(): readonly string[];
  readonly sessions: SessionsPort;
};

export type SlashCommand = {
  readonly name: string;
  readonly otherNames?: readonly string[];
  readonly description: string;
  readonly usage?: string;
  readonly needsSession?: boolean;
  run(args: string, context: SlashContext): Promise<void>;
};

export const namesOf = (command: SlashCommand): readonly string[] => [command.name, ...(command.otherNames ?? [])];

export type SlashRegistry = {
  list(): readonly SlashCommand[];
  find(name: string): SlashCommand | undefined;
};

export const createSlashRegistry = (commands: readonly SlashCommand[]): SlashRegistry => ({
  list: () => commands,
  find: (name) => commands.find((command) => namesOf(command).includes(name)),
});

export const NEEDS_SESSION_NOTE = 'This command needs a session. Connect a model first with /login.';

export type ParsedSlash = { name: string; args: string };

export const parseSlash = (line: string): ParsedSlash | undefined => {
  const trimmed = line.trim();
  const match = /^\/([^\s/]+)(?:\s+([\s\S]*))?$/.exec(trimmed);
  if (match === null) return undefined;
  return { name: match[1] as string, args: (match[2] ?? '').trim() };
};

const NEWLINE: ActionId = 'prompt.newline';
const KEY_JOIN = ' or ';
const HELP_CONTEXTS: Readonly<Record<ScreenMode, readonly KeyContext[]>> = { fullscreen: ['chat', 'viewport', 'global'], scrollback: ['chat', 'global'] };
const MOUSE_HELP: Readonly<Record<ScreenMode, readonly string[]>> = {
  fullscreen: ['wheel: scroll', 'drag: select', 'double click: select a word', 'triple click: select a line', 'click on a link: open it', 'click in the input: place the caret', 'click on a menu row: complete it'],
  scrollback: [],
};

export const newlineHelpLines = (keys: KeyTable, negotiation: NegotiationState): string[] => {
  const description = keys.rows().find((row) => row.id === NEWLINE)?.description;
  const all = keys.keysFor(NEWLINE);
  const escaped = all.filter(sentAsEscape);
  const direct = all.filter((spec) => !sentAsEscape(spec));
  const unproven = direct.filter((spec) => needsReport(spec) && !keyReported(spec, negotiation));
  const acting = (spec: KeySpec): boolean => direct.includes(spec) && !unproven.includes(spec);
  const actingKeys = keys.hintFor(NEWLINE, acting);
  const submit = keys.hintFor('prompt.submit');
  return [
    ...(actingKeys === '' && unproven.length === 0 ? [] : [`${actingKeys}: ${description}${unproven.length === 0 ? '' : ` (${unproven.map(shownKey).join(KEY_JOIN)} works only if this terminal reports it; this one has not)`}`]),
    ...escaped.map((spec) => `${shownKey(spec)}: ${description} where the terminal sends Alt as Escape`),
    ...(submit === '' ? [] : [`\\ then ${submit}: ${description}`]),
  ];
};

export type HelpFacts = { commands: readonly SlashCommand[]; keys: KeyTable; negotiation: NegotiationState; screen: ScreenMode; status?: readonly string[] };

const indented = (lines: readonly string[]): string[] => lines.map((line) => `  ${line}`);

export const helpText = ({ commands, keys, negotiation, screen, status }: HelpFacts): string => {
  const contexts = HELP_CONTEXTS[screen];
  const keyLines = keys
    .rows()
    .filter((row) => contexts.includes(row.context))
    .flatMap((row) => (row.id === NEWLINE ? newlineHelpLines(keys, negotiation) : keys.keysFor(row.id).length === 0 ? [] : [`${keys.hintFor(row.id)}: ${row.description}`]));
  const mouse = MOUSE_HELP[screen];
  return [
    'Commands',
    ...indented(commands.map((command) => `/${command.name}${command.usage === undefined ? '' : ` ${command.usage}`}  ${command.description}`)),
    'Keys',
    ...indented(keyLines),
    ...(mouse.length === 0 ? [] : ['Mouse', ...indented(mouse)]),
    ...(status === undefined ? [] : ['Status', ...indented(status)]),
  ].join('\n');
};

const help: SlashCommand = {
  name: 'help',
  needsSession: false,
  description: 'list the commands, the keys and the mouse actions',
  run: async (_args, context) => {
    const status = context.display.a11y().screenReader ? { status: context.status() } : {};
    context.info(helpText({ commands: context.commands, keys: context.keys, negotiation: context.negotiation, screen: context.screen.current(), ...status }));
  },
};

const exit: SlashCommand = {
  name: 'exit',
  needsSession: false,
  otherNames: ['quit'],
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

export const START_FLAG = '--start';

export const switchModel = async (args: string, entries: readonly MomongaModelEntry[], context: SlashContext): Promise<void> => {
  const words = args.split(/\s+/).filter((word) => word !== '');
  const text = words.filter((word) => word !== START_FLAG).join(' ');
  let chosen: string;
  try {
    chosen = listedModelOf(entries, text);
  } catch (error) {
    if (!(error instanceof ModelRefError)) throw error;
    context.info(error.message);
    return;
  }
  await context.setModel(chosen);
  if (!words.includes(START_FLAG)) return;
  await writeStart(context, chosen);
  context.toast(startingModelSetText(displayMapOf(listingViewsOf(entries)).get(chosen) ?? chosen));
};

export const MODEL_USAGE = `[model] [${START_FLAG}]`;

const model: SlashCommand = {
  name: 'model',
  usage: MODEL_USAGE,
  description: 'list the configured models with the current one marked, or switch the model from the next task',
  run: async (args, context) => {
    const entries = await context.backend.models();
    if (args === '') {
      const displays = displayMapOf(listingViewsOf(entries));
      context.info(
        [
          'models (the current one is marked *):',
          ...entries.map((entry) => `  ${entry.id === context.model ? '*' : ' '} ${displays.get(entry.id) ?? entry.id}  ${isNotListedCapabilities(entry.capabilities) ? notListedMessage(entry.capabilities) : `${entry.capabilities.contextWindow}-token window`}`),
          'switch with /model <model>; a change applies from the next task',
        ].join('\n'),
      );
      return;
    }
    await switchModel(args, entries, context);
  },
};

export const BUILTIN_SLASH_COMMANDS: readonly SlashCommand[] = [help, mode, model, exit];
