import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import { escapeTerminalBlock, escapeTerminalLine } from '@momonga/protocol';
import type { ActionId, KeyContext, KeyTable } from './keys/table.ts';
import { currentA11y } from './screen/a11y.ts';
import type { KeyEvent } from './terminal/events.ts';
import { styleOf as styleOfTokens } from './screen/theme.ts';
import type { StyleToken } from './screen/theme.ts';
import { displayWidth, segmentsOf, withoutTabs, wrapLine } from './screen/wrap.ts';

export type SelectRow = { readonly label: string; readonly value?: string; readonly kept?: string; readonly disabled?: boolean; readonly separator?: boolean; readonly opensBrowser?: boolean; readonly description?: string; readonly searchTexts?: readonly string[] };

export type SelectLine = string | { readonly text: string; readonly token?: StyleToken; readonly dim?: boolean; readonly bold?: boolean; readonly first?: string };

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
  readonly alt?: { readonly label: string; readonly key?: SecondKey };
  readonly enterOff?: true;
};

export type SecondKey = Extract<ActionId, 'select.alt' | 'select.delete'>;

const secondKeyOf = (spec: SelectSpec): SecondKey | undefined => (spec.alt === undefined ? undefined : (spec.alt.key ?? 'select.alt'));

export type SelectState = { readonly index: number; readonly top: number; readonly scrolled: boolean; readonly filter: string; readonly confirming: number | undefined };

export type SelectOutcome =
  | { readonly kind: 'decide'; readonly index: number }
  | { readonly kind: 'alt'; readonly index: number }
  | { readonly kind: 'back' }
  | { readonly kind: 'interrupt'; readonly action: SelectSpec['interrupt'] };

export type SelectStep = { readonly state: SelectState; readonly outcome?: SelectOutcome };

export type SelectFrame = { readonly width: number; readonly rows: number; readonly border: boolean };

export type TextRow = { readonly text: string; readonly token?: StyleToken; readonly dim?: boolean; readonly bold?: boolean };

export type SelectLayout = {
  readonly text: readonly TextRow[];
  readonly more: number;
  readonly moreRow: boolean;
  readonly items: readonly number[];
  readonly itemLines: readonly number[];
  readonly described: boolean;
  readonly rowWidth: number;
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
const LIST_MINIMUM_ROWS = 2;
const TEXT_KEPT_ROWS = 2;
const BORDER_ROWS = 2;
const BORDER_COLUMNS = 4;
const CONTINUATION = '  ';

export const joinHint = (parts: readonly string[]): string => parts.join(HINT_SEPARATOR);

export const SELECT_CONTEXTS: readonly KeyContext[] = ['select'];

export const selectHint = (spec: SelectSpec, keys: KeyTable): string => {
  const decide = keys.keyHint('select.decide');
  const digits = spec.decideOn === 'immediate' && !spec.filter ? ['1-9'] : [];
  const choosers = [...digits, ...(decide === '' || spec.enterOff === true ? [] : [decide])];
  const choose = choosers.length === 0 ? [] : [`${choosers.join(' or ')} to choose`];
  const move = keyed(keyPair(keys, 'select.up', 'select.down'), (key) => `${key} to move`);
  const escapeKey = keys.keyHint('select.escape');
  const escapeRow = typeof spec.escape === 'number' ? spec.rows[spec.escape] : undefined;
  const alt = spec.alt;
  return joinHint([
    ...(spec.decideOn === 'enter' ? [...move, ...choose] : [...choose, ...move]),
    ...(spec.filter ? ['type to filter'] : []),
    ...(alt === undefined ? [] : keyed(keys.keyHint(alt.key ?? 'select.alt'), (key) => `${key}: ${alt.label}`)),
    ...(spec.escape === 'back' ? keyed(escapeKey, (key) => `${key}: go back`) : []),
    ...(escapeRow === undefined ? [] : keyed(escapeKey, (key) => `${key}: ${escapeRow.label}`)),
    ...(spec.interrupt === 'cancel-run' ? keyed(keys.keyHint('select.interrupt'), (key) => `${key}: cancel the run`) : []),
  ]);
};

const PART_GAP = '  ';

export const rowText = (row: SelectRow): string => (row.value === undefined ? row.label : `${row.label}${PART_GAP}${row.value}`);

const matches = (row: SelectRow, filter: string): boolean => [rowText(row), ...(row.searchTexts ?? [])].some((text) => text.toLowerCase().includes(filter.toLowerCase()));

const listedOf = (spec: SelectSpec, filter: string): number[] => spec.rows.flatMap((row, index) => (filter === '' || (row.separator !== true && matches(row, filter)) ? [index] : []));

const stopsOf = (spec: SelectSpec, filter: string): number[] => listedOf(spec, filter).filter((index) => spec.rows[index]?.separator !== true);

export const selectStart = (spec: SelectSpec): SelectState => ({ index: spec.initial, top: 0, scrolled: false, filter: '', confirming: undefined });

export const selectWithFilter = (spec: SelectSpec, filter: string): SelectState => {
  if (filter === '' || !spec.filter) return selectStart(spec);
  const stops = stopsOf(spec, filter);
  const index = stops.includes(spec.initial) ? spec.initial : (stops[0] ?? spec.initial);
  return { index, top: 0, scrolled: false, filter, confirming: undefined };
};

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
      if (spec.enterOff === true) return { state };
      return stopsOf(spec, state.filter).includes(state.index) ? chosen(spec, state, state.index, capacity) : { state };
    case 'select.escape':
      if (state.filter !== '') return filtered(spec, state, '', capacity);
      if (spec.escape === 'back') return { state, outcome: { kind: 'back' } };
      return spec.escape === 'inactive' ? { state } : { state, outcome: { kind: 'decide', index: spec.escape } };
    case 'select.alt':
    case 'select.delete':
      return action === secondKeyOf(spec) && spec.rows[state.index]?.disabled !== true && stopsOf(spec, state.filter).includes(state.index) ? { state, outcome: { kind: 'alt', index: state.index } } : { state };
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
    const waitsForEnter = spec.rows[index]?.opensBrowser === true && spec.enterOff !== true;
    return spec.decideOn === 'immediate' && !waitsForEnter ? chosen(spec, state, index, capacity) : { state: { ...highlighted(spec, state, index, capacity), confirming: undefined } };
  }
  return { state };
};

export const selectClick = (spec: SelectSpec, state: SelectState, index: number): SelectStep => {
  const row = spec.rows[index];
  if (row === undefined || row.separator === true) return { state };
  return chosen(spec, state, index, Number.POSITIVE_INFINITY);
};

export const selectHover = (spec: SelectSpec, state: SelectState, index: number): SelectState => (stopsOf(spec, state.filter).includes(index) ? { ...state, index, confirming: undefined } : state);

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

export type RowPlace = { readonly numberWidth: number };

const NO_PLACE: RowPlace = { numberWidth: 0 };

const placeOf = (spec: SelectSpec): RowPlace => ({ numberWidth: String(stopsOf(spec, '').length).length });

const choiceText = (label: string, number: number | undefined, disabled: boolean | undefined, place: RowPlace): string =>
  `${number === undefined ? '' : `${String(number).padStart(place.numberWidth)}. `}${escapeTerminalLine(label)}${disabled === true ? ' (unavailable)' : ''}`;

const choicePrefix = (selected: boolean, screenReader: boolean): string => (screenReader ? '' : `${selected ? SELECTED_MARKER : ' '} `);

const ELLIPSIS = '…';
const KEY_SHORTEST = 12;

const widthSlice = (text: string, room: number, from: 'start' | 'end'): string => {
  const segments = segmentsOf(text);
  const ordered = from === 'start' ? segments : [...segments].reverse();
  const taken: string[] = [];
  let used = 0;
  for (const { segment, width } of ordered) {
    if (used + width > room) break;
    taken.push(segment);
    used += width;
  }
  return (from === 'start' ? taken : taken.reverse()).join('');
};

const lastSegmentOf = (text: string): string => text.slice(text.trimEnd().lastIndexOf(' ') + 1);

export const shortenedKey = (key: string, room: number): string => {
  if (displayWidth(key) <= room) return key;
  if (room <= displayWidth(ELLIPSIS)) return widthSlice(key, room, 'start');
  const inner = room - displayWidth(ELLIPSIS);
  const tailWidth = Math.min(inner, Math.max(displayWidth(lastSegmentOf(key)), Math.ceil(inner / 2)));
  return `${widthSlice(key, inner - tailWidth, 'start').trimEnd()}${ELLIPSIS}${widthSlice(key, tailWidth, 'end')}`;
};

export type ChoiceParts = { readonly key: string; readonly value?: string; readonly kept?: string };

const ownLines = (text: string, indentWidth: number, width: number): string[] => {
  const indent = ' '.repeat(Math.max(0, Math.min(indentWidth, width - displayWidth(text))));
  return wrapLine(text, Math.max(1, width - indent.length), { links: false }).map((row) => `${indent}${row.text}`);
};

export const choiceLines = ({ key, value, kept }: ChoiceParts, prefix: string, width: number, whole: boolean): string[] => {
  const shownValue = value === undefined ? undefined : escapeTerminalLine(value);
  const shownKept = kept === undefined ? undefined : escapeTerminalLine(kept);
  const head = `${prefix}${key}`;
  const withValue = shownValue === undefined ? head : `${head}${PART_GAP}${shownValue}`;
  const keptLines = shownKept === undefined ? [] : ownLines(shownKept, displayWidth(prefix) + PART_GAP.length, width);
  if (shownKept !== undefined && displayWidth(`${withValue}${PART_GAP}${shownKept}`) <= width) return [`${withValue}${PART_GAP}${shownKept}`];
  if (displayWidth(withValue) <= width || shownValue === undefined) return [withValue, ...keptLines];
  const keyRoom = width - displayWidth(prefix) - PART_GAP.length - displayWidth(shownValue);
  const shortest = Math.min(displayWidth(key), KEY_SHORTEST);
  if (keyRoom >= shortest) return [`${prefix}${shortenedKey(key, keyRoom)}${PART_GAP}${shownValue}`, ...keptLines];
  if (!whole) return [`${prefix}${shortenedKey(key, shortest)}${PART_GAP}${shownValue}`, ...keptLines];
  return [`${prefix}${shortenedKey(key, Math.max(1, width - displayWidth(prefix)))}`, ...ownLines(shownValue, displayWidth(prefix) + PART_GAP.length, width), ...keptLines];
};

const partsOf = (row: SelectRow, number: number | undefined, place: RowPlace): ChoiceParts => ({ key: choiceText(row.label, number, row.disabled, place), ...(row.value === undefined ? {} : { value: row.value }), ...(row.kept === undefined ? {} : { kept: row.kept }) });

export const descriptionLines = (description: string, prefix: string, width: number): string[] => {
  const indent = ' '.repeat(Math.max(0, Math.min(displayWidth(prefix) + PART_GAP.length, width - 1)));
  return wrapLine(withoutTabs(escapeTerminalLine(description)), Math.max(1, width - indent.length), { links: false }).map((row) => `${indent}${row.text}`);
};

const linesOfRow = (row: SelectRow | undefined, number: number, place: RowPlace, width: number, screenReader: boolean, selected: boolean, described: boolean): number => {
  if (row === undefined || row.separator === true) return 1;
  const prefix = choicePrefix(selected, screenReader);
  return choiceLines(partsOf(row, number, place), prefix, width, selected).length + (!described || row.description === undefined ? 0 : descriptionLines(row.description, prefix, width).length);
};

export const selectLayout = (spec: SelectSpec, state: SelectState, text: readonly TextRow[], frame: SelectFrame, extraRows: number, screenReader: boolean): SelectLayout => {
  const listed = listedOf(spec, state.filter);
  const stops = stopsOf(spec, state.filter);
  const border = frame.border ? BORDER_ROWS : 0;
  const filterRows = spec.filter ? 1 : 0;
  const rowWidth = innerWidth(frame);
  const tallRowsOf = (described: boolean): number => listed.reduce((sum, index) => sum + linesOfRow(spec.rows[index], stops.indexOf(index) + 1, placeOf(spec), rowWidth, screenReader, index === state.index, described) - 1, 0);
  const chrome = border + filterRows + (state.confirming === undefined ? 0 : 1) + extraRows + 1;
  const described = chrome + tallRowsOf(true) + listed.length + Math.min(text.length, TEXT_KEPT_ROWS) <= frame.rows;
  const tallRows = tallRowsOf(described);
  const fixed = chrome + tallRows;
  const available = Math.max(0, frame.rows - fixed);
  const count = Math.max(1, listed.length);
  const titleRows = Math.min(text.length, TEXT_KEPT_ROWS);
  const titleKept = available - titleRows >= Math.min(count, LIST_MINIMUM_ROWS);
  const listRows = count + text.length <= available ? count : Math.min(count, Math.max(LIST_FLOOR_ROWS, available - text.length), available - (titleKept ? titleRows : 0));
  const textRoom = Math.max(0, available - listRows);
  const shown = text.length <= textRoom ? text : text.slice(0, Math.max(0, textRoom - 1));
  const more = text.length - shown.length;
  const moreRow = more > 0 && textRoom > 0;
  const capacity = Math.max(1, listRows);
  const position = Math.max(0, listed.indexOf(state.index));
  const windowed = spanAt(listed.length, state.scrolled ? state.top : topFor(position, state.top, listed.length, capacity), capacity);
  const onlyHighlighted = listed.length > 0 && windowed.end <= windowed.start;
  const span = onlyHighlighted ? { start: position, end: position + 1 } : windowed;
  const items = listed.slice(span.start, span.end);
  return {
    text: shown,
    more,
    moreRow,
    items,
    itemLines: items.map((index) => linesOfRow(spec.rows[index], stops.indexOf(index) + 1, placeOf(spec), rowWidth, screenReader, index === state.index, described)),
    described,
    rowWidth,
    above: onlyHighlighted ? 0 : span.start,
    below: onlyHighlighted ? 0 : listed.length - span.end,
    listTop: border / 2 + shown.length + (moreRow ? 1 : 0) + filterRows,
    capacity,
  };
};

export const selectRowAt = (layout: SelectLayout, row: number): number | undefined => {
  let slot = row - layout.listTop - (layout.above > 0 ? 1 : 0);
  if (slot < 0) return undefined;
  for (const [position, index] of layout.items.entries()) {
    const lines = layout.itemLines[position] ?? 1;
    if (slot < lines) return index;
    slot -= lines;
  }
  return undefined;
};

export const detailCapacity = (frame: SelectFrame): number => Math.max(1, frame.rows - (frame.border ? BORDER_ROWS : 0) - 1);

export const detailTop = (text: readonly TextRow[], frame: SelectFrame, top: number): number => Math.max(0, Math.min(top, text.length - detailCapacity(frame)));

const styleOf = (row: TextRow) => ({
  ...(row.token === undefined ? {} : styleOfTokens([row.token])),
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

export function ChoiceRow({ selected, label, number, place = NO_PLACE, disabled, value, kept, description, width }: { selected: boolean; label: string; number?: number; place?: RowPlace; disabled?: boolean; value?: string; kept?: string; description?: string; width?: number }) {
  const { screenReader } = currentA11y();
  const style = selected && !screenReader ? styleOfTokens(['choice.selected']) : {};
  const prefix = choicePrefix(selected, screenReader);
  const room = width ?? Number.POSITIVE_INFINITY;
  const lines = choiceLines(partsOf({ label, ...(value === undefined ? {} : { value }), ...(kept === undefined ? {} : { kept }), ...(disabled === true ? { disabled } : {}) }, number, place), prefix, room, selected);
  const explained = description === undefined ? [] : descriptionLines(description, prefix, room);
  return (
    <>
      {lines.map((line, index) => (
        <Text key={index} wrap="truncate" {...style}>
          {line}
        </Text>
      ))}
      {explained.map((line, index) => (
        <Text key={`description-${index}`} dimColor wrap="truncate">
          {line}
        </Text>
      ))}
    </>
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
  const stops = stopsOf(spec, state.filter);
  const confirming = state.confirming === undefined ? undefined : spec.rows[state.confirming];
  const highlightedRow = spec.rows[state.index];
  return (
    <Panel border={border}>
      <TextRows rows={layout.text} />
      {layout.moreRow ? <Text dimColor wrap="truncate">{moreLinesText(layout.more, keys)}</Text> : null}
      {screenReader && highlightedRow !== undefined ? <Text wrap="truncate">{escapeTerminalLine(selectedText(rowText(highlightedRow)))}</Text> : null}
      {spec.filter ? <Text wrap="truncate">{`filter: ${escapeTerminalLine(state.filter)}`}</Text> : null}
      {layout.above > 0 ? <MoreRow direction="up" count={layout.above} /> : null}
      {layout.items.length === 0 ? <Text dimColor>{screenReader ? 'no match' : '  no match'}</Text> : null}
      {layout.items.map((index) => {
        const row = spec.rows[index];
        if (row === undefined) return null;
        if (row.separator === true) return <Text key={index} dimColor wrap="truncate">{`${screenReader ? '' : '  '}${escapeTerminalLine(row.label)}`}</Text>;
        return <ChoiceRow key={index} selected={index === state.index} number={stops.indexOf(index) + 1} place={placeOf(spec)} label={row.label} width={layout.rowWidth} {...(row.value === undefined ? {} : { value: row.value })} {...(row.kept === undefined ? {} : { kept: row.kept })} {...(row.disabled === true ? { disabled: true } : {})} {...(!layout.described || row.description === undefined ? {} : { description: row.description })} />;
      })}
      {layout.below > 0 ? <MoreRow direction="down" count={layout.below} /> : null}
      {confirming === undefined || spec.confirm === undefined ? null : <Text {...styleOfTokens(['warning'])} wrap="truncate">{escapeTerminalLine(spec.confirm(confirming, keys.keyHint('select.decide')))}</Text>}
      {error === undefined ? null : <Text {...styleOfTokens(['error'])} wrap="truncate">{escapeTerminalLine(error)}</Text>}
      <Text dimColor wrap="truncate">{sending ? SENDING_TEXT : layout.more > 0 && !layout.moreRow ? moreLinesText(layout.more, keys) : selectHint(spec, keys)}</Text>
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
