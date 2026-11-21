import { useReducer, useRef } from 'react';
import type { ReactNode } from 'react';
import { Box, Text } from 'ink';
import type { PlanProfileView } from '@momonga/protocol';
import type { KeyTable } from '../keys/table.ts';
import { ChoiceRow, MoreRow, spanAt, topFor } from '../select.tsx';
import { namesOf } from '../slash.ts';
import type { SlashCommand, SlashSubcommand } from '../slash.ts';
import { menuRowsCap } from './layout.ts';
import { inertText, wrapLine } from './wrap.ts';

export type Invitation = { profile: PlanProfileView };

export const NOT_NOW_LABEL = 'Not now';

export const invitationKeyOf = (profile: string): string => `invite:${profile}`;

export const invitationLine = (invitation: Invitation, keys: KeyTable): string => {
  const hide = keys.keyHint('run.stop');
  return `${invitation.profile.messages.inviteTitle} /login connects it${hide === '' ? '' : ` · ${hide} hides this line`}`;
};

export const invitationRows = (invitation: Invitation, keys: KeyTable, columns: number): string[] => wrapLine(inertText(invitationLine(invitation, keys)), columns).map((row) => row.text.trimEnd());

export function InvitationLine({ rows }: { rows: readonly string[] }) {
  return (
    <>
      {rows.map((row, index) => (
        <Text key={index} dimColor wrap="truncate">
          {row}
        </Text>
      ))}
    </>
  );
}

const COMPLETABLE = /^\/[^\s/]*$/;
const WITH_SPACE = /^\/([^\s/]+)[ \t]+([^\r\n]*)$/;
const MENU_FLOOR_ROWS = 3;

const windowRows = (rows: number): number => Math.max(MENU_FLOOR_ROWS, rows);

export type SlashMenuEntry = {
  readonly key: string;
  readonly label: string;
  readonly completeText: string;
  readonly runText: string;
  readonly continueOnEnter: boolean;
};

const rankItems = <T extends { readonly name: string }>(items: readonly T[], typed: string, namesFor: (item: T) => readonly string[]): T[] => {
  const rankOf = (item: T): number => {
    const names = namesFor(item).map((name) => name.toLowerCase());
    if (names.includes(typed)) return 0;
    if (names.some((name) => name.startsWith(typed))) return 1;
    return names.some((name) => name.includes(typed)) ? 2 : 3;
  };
  return [0, 1, 2].flatMap((rank) => items.filter((item) => rankOf(item) === rank).toSorted((left, right) => left.name.length - right.name.length));
};

export const slashMatches = (text: string, commands: readonly SlashCommand[]): SlashCommand[] | undefined => {
  if (!COMPLETABLE.test(text)) return undefined;
  return rankItems(commands, text.slice(1).toLowerCase(), namesOf);
};

export const noCommandsMatch = (text: string): string => `No commands match "${text}"`;

const labelOf = (command: SlashCommand): string => `/${command.name}${command.usage === undefined ? '' : ` ${command.usage}`}  ${command.description}`;

const completedOf = (command: SlashCommand): string => `/${command.name} `;

const subcommandEntryOf = (prefix: readonly string[], subcommand: SlashSubcommand): SlashMenuEntry => {
  const full = `/${[...prefix, subcommand.name].join(' ')}`;
  return {
    key: full,
    label: `${full}${subcommand.usage === undefined ? '' : ` ${subcommand.usage}`}  ${subcommand.description}`,
    completeText: `${full} `,
    runText: full,
    continueOnEnter: (subcommand.subcommands?.length ?? 0) > 0 && subcommand.standalone !== true,
  };
};

export const slashMenuEntries = (text: string, commands: readonly SlashCommand[]): SlashMenuEntry[] | undefined => {
  const top = slashMatches(text, commands);
  if (top !== undefined) {
    return top.map((command) => ({
      key: command.name,
      label: labelOf(command),
      completeText: completedOf(command),
      runText: `/${command.name}`,
      continueOnEnter: false,
    }));
  }
  const spaced = WITH_SPACE.exec(text);
  if (spaced === null) return undefined;
  const head = (spaced[1] ?? '').toLowerCase();
  const rest = spaced[2] ?? '';
  const command = commands.find((candidate) => namesOf(candidate).some((name) => name.toLowerCase() === head));
  if (command?.subcommands === undefined || command.subcommands.length === 0) return undefined;
  const trailingSpace = /\s$/.test(rest);
  const parts = rest.trim() === '' ? [] : rest.trim().split(/\s+/);
  const completed = trailingSpace ? parts : parts.slice(0, -1);
  const partial = trailingSpace ? '' : (parts.at(-1) ?? '').toLowerCase();
  let nodes: readonly SlashSubcommand[] = command.subcommands;
  const prefix: string[] = [command.name];
  for (const word of completed) {
    const lower = word.toLowerCase();
    const next = nodes.find((candidate) => candidate.name.toLowerCase() === lower);
    if (next?.subcommands === undefined || next.subcommands.length === 0) return undefined;
    prefix.push(next.name);
    nodes = next.subcommands;
  }
  if (partial.startsWith('-')) return undefined;
  const matched = partial === '' ? [...nodes] : rankItems(nodes, partial, (item) => [item.name]);
  return matched.length === 0 ? undefined : matched.map((subcommand) => subcommandEntryOf(prefix, subcommand));
};

export type SlashMenuAct = { readonly kind: 'handled' } | { readonly kind: 'complete'; readonly text: string } | { readonly kind: 'run'; readonly text: string };

export const MENU_ACTIONS = ['menu.up', 'menu.down', 'menu.complete', 'menu.run', 'menu.close'] as const;

export type MenuAction = (typeof MENU_ACTIONS)[number];

export const isMenuAction = (action: string | undefined): action is MenuAction => MENU_ACTIONS.some((known) => known === action);

export type SlashMenu = {
  open: boolean;
  isOpen(text: string): boolean;
  rows: number;
  act(text: string, action: MenuAction): SlashMenuAct | undefined;
  hover(row: number, rows: number): boolean;
  press(row: number, rows: number): SlashMenuAct | undefined;
  wheel(rows: number): void;
  view(rows: number): ReactNode;
};

type MenuState = { text: string; index: number; top: number; closed: boolean };

export const useSlashMenu = (host: { text: string; commands: readonly SlashCommand[]; active: boolean; height: number }): SlashMenu => {
  const held = useRef<MenuState>({ text: '', index: 0, top: 0, closed: false });
  const [, redraw] = useReducer((count: number) => count + 1, 0);
  const cap = Math.max(MENU_FLOOR_ROWS, menuRowsCap(host.height));

  const stateFor = (text: string): MenuState => (held.current.text === text ? held.current : { text, index: 0, top: 0, closed: false });

  const keep = (next: MenuState): void => {
    held.current = next;
    redraw();
  };

  const matchesFor = (text: string): SlashMenuEntry[] | undefined => (host.active && !stateFor(text).closed ? slashMenuEntries(text, host.commands) : undefined);

  if (held.current.text !== host.text) held.current = stateFor(host.text);
  const shown = matchesFor(host.text);
  const state = stateFor(host.text);

  const commandIndexAt = (count: number, row: number, rows: number): number | undefined => {
    const span = spanAt(count, state.top, windowRows(rows));
    const lead = span.start > 0 ? 1 : 0;
    const at = span.start + row - lead;
    return row < lead || at >= span.end ? undefined : at;
  };

  const moveTo = (text: string, index: number, count: number): void => keep({ ...stateFor(text), index, top: topFor(index, stateFor(text).top, count, cap) });

  return {
    open: shown !== undefined,
    isOpen: (text) => matchesFor(text) !== undefined,
    rows: shown === undefined ? 0 : Math.max(1, Math.min(shown.length, cap)),
    act: (text, action) => {
      const matches = matchesFor(text);
      if (matches === undefined) return undefined;
      const current = stateFor(text);
      const entry = matches[current.index];
      if (action === 'menu.close') {
        keep({ ...current, closed: true });
        return { kind: 'handled' };
      }
      if (action === 'menu.up' || action === 'menu.down') {
        if (matches.length > 0) moveTo(text, (current.index + (action === 'menu.up' ? matches.length - 1 : 1)) % matches.length, matches.length);
        return { kind: 'handled' };
      }
      if (action === 'menu.complete') return entry === undefined ? { kind: 'handled' } : { kind: 'complete', text: entry.completeText };
      if (entry === undefined) return undefined;
      return entry.continueOnEnter ? { kind: 'complete', text: entry.completeText } : { kind: 'run', text: entry.runText };
    },
    hover: (row, rows) => {
      const at = shown === undefined ? undefined : commandIndexAt(shown.length, row, rows);
      if (at === undefined) return false;
      if (at !== state.index) keep({ ...state, index: at });
      return true;
    },
    press: (row, rows) => {
      if (shown === undefined) return undefined;
      const at = commandIndexAt(shown.length, row, rows);
      const entry = at === undefined ? undefined : shown[at];
      return entry === undefined ? { kind: 'handled' } : { kind: 'complete', text: entry.completeText };
    },
    wheel: (rows) => {
      if (shown === undefined || shown.length <= cap) return;
      keep({ ...state, top: Math.max(0, Math.min(state.top + rows, shown.length - (cap - 1))) });
    },
    view: (rows) => {
      if (shown === undefined) return null;
      if (shown.length === 0) return <Text dimColor wrap="truncate">{noCommandsMatch(inertText(host.text))}</Text>;
      const span = spanAt(shown.length, state.top, windowRows(rows));
      return (
        <Box flexDirection="column">
          {span.start > 0 ? <MoreRow direction="up" count={span.start} /> : null}
          {shown.slice(span.start, span.end).map((entry, offset) => (
            <ChoiceRow key={entry.key} selected={span.start + offset === state.index} label={entry.label} />
          ))}
          {span.end < shown.length ? <MoreRow direction="down" count={shown.length - span.end} /> : null}
        </Box>
      );
    },
  };
};
