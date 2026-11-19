import { useReducer, useRef } from 'react';
import type { ReactNode } from 'react';
import { Box, Text } from 'ink';
import type { PlanProfileView } from '@momonga/protocol';
import type { KeyTable } from '../keys/table.ts';
import { ChoiceRow, MoreRow, spanAt, topFor } from '../select.tsx';
import { namesOf } from '../slash.ts';
import type { SlashCommand } from '../slash.ts';
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
const MENU_FLOOR_ROWS = 3;

const windowRows = (rows: number): number => Math.max(MENU_FLOOR_ROWS, rows);


export const slashMatches = (text: string, commands: readonly SlashCommand[]): SlashCommand[] | undefined => {
  if (!COMPLETABLE.test(text)) return undefined;
  const typed = text.slice(1).toLowerCase();
  const rankOf = (command: SlashCommand): number => {
    const names = namesOf(command).map((name) => name.toLowerCase());
    if (names.includes(typed)) return 0;
    if (names.some((name) => name.startsWith(typed))) return 1;
    return names.some((name) => name.includes(typed)) ? 2 : 3;
  };
  return [0, 1, 2].flatMap((rank) => commands.filter((command) => rankOf(command) === rank).toSorted((left, right) => left.name.length - right.name.length));
};

export const noCommandsMatch = (text: string): string => `No commands match "${text}"`;

const labelOf = (command: SlashCommand): string => `/${command.name}${command.usage === undefined ? '' : ` ${command.usage}`}  ${command.description}`;

const completedOf = (command: SlashCommand): string => `/${command.name} `;

export type SlashMenuAct = { readonly kind: 'handled' } | { readonly kind: 'complete'; readonly text: string } | { readonly kind: 'run'; readonly text: string };

export const MENU_ACTIONS = ['menu.up', 'menu.down', 'menu.complete', 'menu.run', 'menu.close'] as const;

export type MenuAction = (typeof MENU_ACTIONS)[number];

export const isMenuAction = (action: string | undefined): action is MenuAction => MENU_ACTIONS.some((known) => known === action);

export type SlashMenu = {
  open: boolean;
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

  const matchesFor = (text: string): SlashCommand[] | undefined => (host.active && !stateFor(text).closed ? slashMatches(text, host.commands) : undefined);

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
    rows: shown === undefined ? 0 : Math.max(1, Math.min(shown.length, cap)),
    act: (text, action) => {
      const matches = matchesFor(text);
      if (matches === undefined) return undefined;
      const current = stateFor(text);
      const command = matches[current.index];
      if (action === 'menu.close') {
        keep({ ...current, closed: true });
        return { kind: 'handled' };
      }
      if (action === 'menu.up' || action === 'menu.down') {
        if (matches.length > 0) moveTo(text, (current.index + (action === 'menu.up' ? matches.length - 1 : 1)) % matches.length, matches.length);
        return { kind: 'handled' };
      }
      if (action === 'menu.complete') return command === undefined ? { kind: 'handled' } : { kind: 'complete', text: completedOf(command) };
      return command === undefined ? undefined : { kind: 'run', text: `/${command.name}` };
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
      const command = at === undefined ? undefined : shown[at];
      return command === undefined ? { kind: 'handled' } : { kind: 'complete', text: completedOf(command) };
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
          {shown.slice(span.start, span.end).map((command, offset) => (
            <ChoiceRow key={command.name} selected={span.start + offset === state.index} label={labelOf(command)} />
          ))}
          {span.end < shown.length ? <MoreRow direction="down" count={shown.length - span.end} /> : null}
        </Box>
      );
    },
  };
};
