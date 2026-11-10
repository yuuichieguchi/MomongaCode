import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import { escapeTerminalBlock, escapeTerminalLine } from '@momonga/protocol';
import type { ActionId, KeyContext, KeyTable } from './keys/table.ts';
import { currentA11y } from './screen/a11y.ts';
import type { KeyEvent } from './terminal/events.ts';
import { styleOf as styleOfTokens } from './screen/theme.ts';
import { withoutTabs, wrapLine } from './screen/wrap.ts';

export type SelectRow = { readonly label: string; readonly disabled?: boolean; readonly separator?: boolean };

export type SelectLine = string | { readonly text: string; readonly color?: string; readonly dim?: boolean; readonly bold?: boolean; readonly first?: string };

export type SelectSpec = {
  readonly title?: string;
  readonly lines?: readonly SelectLine[];
  readonly rows: readonly SelectRow[];
  readonly initial: number;
  readonly decideOn: 'enter' | 'immediate';
  readonly escape: number | 'back' | 'inactive';
  readonly interrupt: 'exit' | 'cancel-run' | 'back';
  readonly filter: boolean;
  readonly confirm?: (row: SelectRow, decideKey: string) => string;
  readonly alt?: { readonly label: string };
};

export type SelectState = { readonly index: number; readonly top: number; readonly scrolled: boolean; readonly filter: string; readonly confirming: number | undefined };

export type SelectOutcome =
  | { readonly kind: 'decide'; readonly index: number }
  | { readonly kind: 'alt'; readonly index: number }
  | { readonly kind: 'back' }
  | { readonly kind: 'interrupt'; readonly action: SelectSpec['interrupt'] };

export type SelectStep = { readonly state: SelectState; readonly outcome?: SelectOutcome };

export type SelectFrame = { readonly width: number; readonly rows: number; readonly border: boolean };

export type TextRow = { readonly text: string; readonly color?: string; readonly dim?: boolean; readonly bold?: boolean };

export type SelectLayout = {
  readonly text: readonly TextRow[];
  readonly more: number;
  readonly items: readonly number[];
  readonly above: number;
  readonly below: number;
  readonly listTop: number;
  readonly capacity: number;
};

export const SENDING_TEXT = 'sending...';
const keyPair = (keys: KeyTable, first: ActionId, second: ActionId): string => [keys.keyHint(first), keys.keyHint(second)].filter((key) => key !== '').join('/');

const keyed = (key: string, text: (key: string) => string): string[] => (key === '' ? [] : [text(key)]);

export const detailHintParts = (keys: KeyTable): string[] => [...keyed(keyPair(keys, 'viewer.up', 'viewer.down'), (key) => `${key} to scroll`), ...keyed(keys.keyHint('viewer.close'), (key) => `${key} to return`)];

export const moreLinesText = (more: number, keys: KeyTable): string => {
  const key = keys.keyHint('select.detail');
  return `… ${more} more lines${key === '' ? '' : ` (${key} shows all)`}`;
};

export const selectedText = (label: string): string => `selected: ${label}`;

export const SELECTED_MARKER = '›';

const HINT_SEPARATOR = ' · ';
const LIST_FLOOR_ROWS = 3;
const BORDER_ROWS = 2;
const BORDER_COLUMNS = 4;
const CONTINUATION = '  ';

export const joinHint = (parts: readonly string[]): string => parts.join(HINT_SEPARATOR);

export const SELECT_CONTEXTS: readonly KeyContext[] = ['select'];

export const selectHint = (spec: SelectSpec, keys: KeyTable): string => {
  const decide = keys.keyHint('select.decide');
  const digits = spec.decideOn === 'immediate' && !spec.filter ? ['1-9'] : [];
  const choosers = [...digits, ...(decide === '' ? [] : [decide])];
  const choose = choosers.length === 0 ? [] : [`${choosers.join(' or ')} to choose`];
  const move = keyed(keyPair(keys, 'select.up', 'select.down'), (key) => `${key} to move`);
  const escapeKey = keys.keyHint('select.escape');
  const escapeRow = typeof spec.escape === 'number' ? spec.rows[spec.escape] : undefined;
  const alt = spec.alt;
  return joinHint([
    ...(spec.decideOn === 'enter' ? [...move, ...choose] : [...choose, ...move]),
    ...(spec.filter ? ['type to filter'] : []),
    ...(alt === undefined ? [] : keyed(keys.keyHint('select.alt'), (key) => `${key}: ${alt.label}`)),
    ...(spec.escape === 'back' ? keyed(escapeKey, (key) => `${key}: go back`) : []),
    ...(escapeRow === undefined ? [] : keyed(escapeKey, (key) => `${key}: ${escapeRow.label}`)),
    ...(spec.interrupt === 'cancel-run' ? keyed(keys.keyHint('select.interrupt'), (key) => `${key}: cancel the run`) : []),
  ]);
};

const matches = (row: SelectRow, filter: string): boolean => row.label.toLowerCase().includes(filter.toLowerCase());

const listedOf = (spec: SelectSpec, filter: string): number[] => spec.rows.flatMap((row, index) => (filter === '' || (row.separator !== true && matches(row, filter)) ? [index] : []));

const stopsOf = (spec: SelectSpec, filter: string): number[] => listedOf(spec, filter).filter((index) => spec.rows[index]?.separator !== true);

export const selectStart = (spec: SelectSpec): SelectState => ({ index: spec.initial, top: 0, scrolled: false, filter: '', confirming: undefined });

export const spanAt = (count: number, top: number, capacity: number): { start: number; end: number } => {
  if (count <= capacity) return { start: 0, end: count };
  const start = Math.max(0, Math.min(top, count - (capacity - 1)));
  if (start === 0) return { start, end: capacity - 1 };
  const room = capacity - 1;
  return count - start <= room ? { start, end: count } : { start, end: start + room - 1 };
};

export const topFor = (position: number, top: number, count: number, capacity: number): number => {
  let next = Math.max(0, Math.min(top, position));
  while (next < count && spanAt(count, next, capacity).end <= position) next += 1;
  return next;
};

const highlighted = (spec: SelectSpec, state: SelectState, index: number, capacity: number): SelectState => {
  const listed = listedOf(spec, state.filter);
  const position = Math.max(0, listed.indexOf(index));
  return { ...state, index, scrolled: false, top: topFor(position, state.top, listed.length, capacity) };
};

const chosen = (spec: SelectSpec, state: SelectState, index: number, capacity: number): SelectStep => {
  const row = spec.rows[index];
  if (row === undefined || row.separator === true) return { state };
  const at = highlighted(spec, state, index, capacity);
  if (row.disabled === true) return { state: { ...at, confirming: undefined } };
  if (spec.confirm !== undefined && state.confirming !== index) return { state: { ...at, confirming: index } };
  return { state: at, outcome: { kind: 'decide', index } };
};

const moved = (spec: SelectSpec, state: SelectState, capacity: number, target: (position: number, count: number) => number): SelectStep => {
  const stops = stopsOf(spec, state.filter);
  if (stops.length === 0) return { state };
  const index = stops[target(stops.indexOf(state.index), stops.length)];
  return index === undefined ? { state } : { state: { ...highlighted(spec, state, index, capacity), confirming: undefined } };
};

const filtered = (spec: SelectSpec, state: SelectState, filter: string, capacity: number): SelectStep => {
  const [first] = stopsOf(spec, filter);
  const cleared = { ...state, filter, top: 0, confirming: undefined };
  return { state: first === undefined ? cleared : highlighted(spec, cleared, first, capacity) };
};

const DIGIT = /^[1-9]$/;
const PRINTABLE = /^[^\p{Control}]+$/u;

const stepUp = (position: number, count: number): number => (position + count - 1) % count;
const stepDown = (position: number, count: number): number => (position + 1) % count;

export const selectAct = (spec: SelectSpec, state: SelectState, action: ActionId, capacity: number): SelectStep => {
  switch (action) {
    case 'select.interrupt':
      return { state, outcome: { kind: 'interrupt', action: spec.interrupt } };
    case 'select.up':
      return moved(spec, state, capacity, stepUp);
    case 'select.down':
      return moved(spec, state, capacity, stepDown);
    case 'select.pageUp':
      return moved(spec, state, capacity, (position) => Math.max(0, position - capacity));
    case 'select.pageDown':
      return moved(spec, state, capacity, (position, count) => Math.min(count - 1, position + capacity));
    case 'select.first':
      return moved(spec, state, capacity, () => 0);
    case 'select.last':
      return moved(spec, state, capacity, (_, count) => count - 1);
    case 'select.decide':
      return stopsOf(spec, state.filter).includes(state.index) ? chosen(spec, state, state.index, capacity) : { state };
    case 'select.escape':
      if (state.filter !== '') return filtered(spec, state, '', capacity);
      if (spec.escape === 'back') return { state, outcome: { kind: 'back' } };
      return spec.escape === 'inactive' ? { state } : { state, outcome: { kind: 'decide', index: spec.escape } };
    case 'select.alt':
      return spec.alt !== undefined && spec.rows[state.index]?.disabled !== true && stopsOf(spec, state.filter).includes(state.index) ? { state, outcome: { kind: 'alt', index: state.index } } : { state };
    case 'select.filterBack':
      return spec.filter ? filtered(spec, state, state.filter.slice(0, -1), capacity) : { state };
    default:
      return { state };
  }
};

export const selectKey = (spec: SelectSpec, state: SelectState, event: KeyEvent, keys: KeyTable, capacity: number): SelectStep => {
  const typed = keys.typedOf(event);
  const action = spec.filter && typed !== undefined ? undefined : keys.actionOf(SELECT_CONTEXTS, event, 'plain');
  if (action !== undefined) return selectAct(spec, state, action, capacity);
  if (typed === undefined) return { state };
  if (spec.filter) return PRINTABLE.test(typed) ? filtered(spec, state, `${state.filter}${typed}`, capacity) : { state };
  if (DIGIT.test(typed)) {
    const index = stopsOf(spec, state.filter)[Number(typed) - 1];
    if (index === undefined) return { state };
    return spec.decideOn === 'immediate' ? chosen(spec, state, index, capacity) : { state: { ...highlighted(spec, state, index, capacity), confirming: undefined } };
  }
  return { state };
};

export const selectClick = (spec: SelectSpec, state: SelectState, index: number): SelectStep => {
  const row = spec.rows[index];
  if (row === undefined || row.separator === true) return { state };
  if (spec.decideOn === 'immediate') return chosen(spec, state, index, Number.POSITIVE_INFINITY);
  return { state: { ...state, index, confirming: undefined } };
};

export const selectWheel = (spec: SelectSpec, state: SelectState, rows: number, capacity: number): SelectState => {
  const count = listedOf(spec, state.filter).length;
  if (count <= capacity) return state;
  return { ...state, scrolled: true, top: Math.max(0, Math.min(state.top + rows, count - (capacity - 1))) };
};

const innerWidth = (frame: SelectFrame): number => Math.max(1, frame.width - (frame.border ? BORDER_COLUMNS : 0));

const wrapped = (line: SelectLine, width: number): TextRow[] => {
  const { text, ...style } = typeof line === 'string' ? { text: line } : line;
  const { first, ...shown } = style;
  return escapeTerminalBlock(text.replaceAll('\r\n', '\n'))
    .split('\n')
    .flatMap((part, index) => wrapLine(withoutTabs(part), width, { first: index === 0 ? (first ?? '') : first === undefined ? '' : CONTINUATION, rest: first === undefined ? '' : CONTINUATION, links: false }))
    .map((row) => ({ ...shown, text: row.text }));
};

export const selectText = (spec: SelectSpec, frame: SelectFrame): TextRow[] => {
  const width = innerWidth(frame);
  return [...(spec.title === undefined ? [] : wrapped({ text: spec.title, bold: true }, width)), ...(spec.lines ?? []).flatMap((line) => wrapped(line, width))];
};

export const selectLayout = (spec: SelectSpec, state: SelectState, text: readonly TextRow[], frame: SelectFrame, extraRows: number): SelectLayout => {
  const listed = listedOf(spec, state.filter);
  const border = frame.border ? BORDER_ROWS : 0;
  const filterRows = spec.filter ? 1 : 0;
  const fixed = border + filterRows + (state.confirming === undefined ? 0 : 1) + extraRows + 1;
  const available = Math.max(0, frame.rows - fixed);
  const count = Math.max(1, listed.length);
  const listRows = count + text.length <= available ? count : Math.min(count, Math.max(LIST_FLOOR_ROWS, available - text.length));
  const textRoom = Math.max(0, available - listRows);
  const shown = text.length <= textRoom ? text : text.slice(0, Math.max(0, textRoom - 1));
  const more = text.length - shown.length;
  const capacity = Math.max(LIST_FLOOR_ROWS, listRows);
  const position = Math.max(0, listed.indexOf(state.index));
  const span = spanAt(listed.length, state.scrolled ? state.top : topFor(position, state.top, listed.length, capacity), capacity);
  return {
    text: shown,
    more,
    items: listed.slice(span.start, span.end),
    above: span.start,
    below: listed.length - span.end,
    listTop: border / 2 + shown.length + (more > 0 ? 1 : 0) + filterRows,
    capacity,
  };
};

export const selectRowAt = (layout: SelectLayout, row: number): number | undefined => {
  const slot = row - layout.listTop - (layout.above > 0 ? 1 : 0);
  return slot < 0 ? undefined : layout.items[slot];
};

export const detailCapacity = (frame: SelectFrame): number => Math.max(1, frame.rows - (frame.border ? BORDER_ROWS : 0) - 1);

export const detailTop = (text: readonly TextRow[], frame: SelectFrame, top: number): number => Math.max(0, Math.min(top, text.length - detailCapacity(frame)));

const styleOf = (row: TextRow): { color?: string; dimColor?: boolean; bold?: boolean } => ({
  ...(row.color === undefined ? {} : { color: row.color }),
  ...(row.dim === true ? { dimColor: true } : {}),
  ...(row.bold === true ? { bold: true } : {}),
});

function TextRows({ rows }: { rows: readonly TextRow[] }) {
  return (
    <>
      {rows.map((row, index) => (
        <Text key={index} wrap="truncate" {...styleOf(row)}>
          {row.text === '' ? ' ' : row.text}
        </Text>
      ))}
    </>
  );
}

function Panel({ border, children }: { border: boolean; children: ReactNode }) {
  const { screenReader } = currentA11y();
  return border && !screenReader ? (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      {children}
    </Box>
  ) : (
    <Box flexDirection="column">{children}</Box>
  );
}

export function ChoiceRow({ selected, label, number, disabled }: { selected: boolean; label: string; number?: number; disabled?: boolean }) {
  const { screenReader } = currentA11y();
  const text = `${number === undefined ? '' : `${number}. `}${escapeTerminalLine(label)}${disabled === true ? ' (unavailable)' : ''}`;
  if (screenReader) return <Text wrap="truncate">{text}</Text>;
  return (
    <Text wrap="truncate" {...(selected ? styleOfTokens(['choice.selected']) : {})}>
      {`${selected ? SELECTED_MARKER : ' '} ${text}`}
    </Text>
  );
}

export const moreRowText = (direction: 'up' | 'down', count: number, screenReader: boolean): string => (screenReader ? `${count} more ${direction === 'up' ? 'above' : 'below'}` : `  ${direction === 'up' ? '↑' : '↓'} ${count} more`);

export function MoreRow({ direction, count }: { direction: 'up' | 'down'; count: number }) {
  const { screenReader } = currentA11y();
  return <Text dimColor wrap="truncate">{moreRowText(direction, count, screenReader)}</Text>;
}

export type SelectViewProps = { spec: SelectSpec; state: SelectState; layout: SelectLayout; border: boolean; sending: boolean; keys: KeyTable; error?: string };

export function SelectView({ spec, state, layout, border, sending, keys, error }: SelectViewProps) {
  const { screenReader } = currentA11y();
  const stops = spec.rows.flatMap((row, index) => (row.separator === true ? [] : [index]));
  const confirming = state.confirming === undefined ? undefined : spec.rows[state.confirming];
  const highlightedRow = spec.rows[state.index];
  return (
    <Panel border={border}>
      <TextRows rows={layout.text} />
      {layout.more > 0 ? <Text dimColor wrap="truncate">{moreLinesText(layout.more, keys)}</Text> : null}
      {screenReader && highlightedRow !== undefined ? <Text wrap="truncate">{escapeTerminalLine(selectedText(highlightedRow.label))}</Text> : null}
      {spec.filter ? <Text wrap="truncate">{`filter: ${escapeTerminalLine(state.filter)}`}</Text> : null}
      {layout.above > 0 ? <MoreRow direction="up" count={layout.above} /> : null}
      {layout.items.length === 0 ? <Text dimColor>{screenReader ? 'no match' : '  no match'}</Text> : null}
      {layout.items.map((index) => {
        const row = spec.rows[index];
        if (row === undefined) return null;
        if (row.separator === true) return <Text key={index} dimColor wrap="truncate">{`${screenReader ? '' : '  '}${escapeTerminalLine(row.label)}`}</Text>;
        return <ChoiceRow key={index} selected={index === state.index} number={stops.indexOf(index) + 1} label={row.label} {...(row.disabled === true ? { disabled: true } : {})} />;
      })}
      {layout.below > 0 ? <MoreRow direction="down" count={layout.below} /> : null}
      {confirming === undefined || spec.confirm === undefined ? null : <Text {...styleOfTokens(['warning'])} wrap="truncate">{escapeTerminalLine(spec.confirm(confirming, keys.keyHint('select.decide')))}</Text>}
      {error === undefined ? null : <Text {...styleOfTokens(['error'])} wrap="truncate">{escapeTerminalLine(error)}</Text>}
      <Text dimColor wrap="truncate">{sending ? SENDING_TEXT : selectHint(spec, keys)}</Text>
    </Panel>
  );
}

export function DetailView({ text, frame, top, keys }: { text: readonly TextRow[]; frame: SelectFrame; top: number; keys: KeyTable }) {
  const from = detailTop(text, frame, top);
  return (
    <Panel border={frame.border}>
      <TextRows rows={text.slice(from, from + detailCapacity(frame))} />
      <Text dimColor wrap="truncate">{joinHint(detailHintParts(keys))}</Text>
    </Panel>
  );
}
