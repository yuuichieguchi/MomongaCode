import { describe, expect, it } from 'vitest';
import { INBOX_MAX_PENDING } from '@momonga/protocol';
import type { InboxRowView } from '@momonga/protocol';
import { INBOX_FULL_HINT, INBOX_ROWS_SHOWN, busyDeliveryOf, busyHint, completionHint, draftOf, isInboxFull, onFirstLine, takenBack, waitingRows } from '../../src/tui/busy-input.ts';
import { emptyEditor, insertText, placeCaret } from '../../src/tui/editor.ts';
import { BUSY_KEYS, DEFAULT_KEY_TABLE, KEYS, createKeyTable } from '../../src/tui/keys/table.ts';
import type { KeyEvent } from '../../src/tui/terminal/events.ts';

const named = (name: string): KeyEvent => ({ type: 'key', name, ctrl: false, alt: false, shift: false }) as KeyEvent;
const ctrl = (text: string): KeyEvent => ({ type: 'key', text, ctrl: true, alt: false, shift: false }) as KeyEvent;

const row = (seq: number, delivery: 'steer' | 'queue', text: string): InboxRowView => ({ id: `row-${seq}`, sessionId: 's', delivery, text, seq, state: 'pending', createdAt: 1, settledAt: null });

const rebound = createKeyTable(
  KEYS.map((entry) => (entry.id === 'prompt.queue' ? { ...entry, default: ['ctrl+q'] } : entry.id === 'prompt.steer' ? { ...entry, default: ['ctrl+s'] } : entry.id === 'run.stop' ? { ...entry, default: ['ctrl+x'] } : entry)),
);

describe('the busy keys (design 5.3)', () => {
  it('is one constant: Enter steers and Tab, the second key, queues, as the two table rows', () => {
    expect(BUSY_KEYS).toEqual({ enter: 'steer', second: 'tab' });
    expect(DEFAULT_KEY_TABLE.keysFor('prompt.queue')).toEqual(['tab']);
    expect(DEFAULT_KEY_TABLE.keysFor('prompt.steer')).toEqual(['enter']);
    expect(KEYS.filter((entry) => entry.id === 'prompt.queue' || entry.id === 'prompt.steer').map((entry) => entry.context)).toEqual(['chat', 'chat']);
  });

  it('reads what a pressed action does while a run works from the table, so a rebinding moves it', () => {
    expect(DEFAULT_KEY_TABLE.actionOf(['chat'], named('enter'))).toBe('prompt.submit');
    expect(DEFAULT_KEY_TABLE.actionOf(['chat'], named('tab'))).toBe('prompt.queue');
    expect(busyDeliveryOf(DEFAULT_KEY_TABLE, 'prompt.submit')).toBe('steer');
    expect(busyDeliveryOf(DEFAULT_KEY_TABLE, 'prompt.queue')).toBe('queue');
    expect(busyDeliveryOf(DEFAULT_KEY_TABLE, 'prompt.steer')).toBe('steer');
    expect(busyDeliveryOf(DEFAULT_KEY_TABLE, 'editor.up')).toBeUndefined();
    expect(busyDeliveryOf(DEFAULT_KEY_TABLE, undefined)).toBeUndefined();
    expect(rebound.actionOf(['chat'], ctrl('q'))).toBe('prompt.queue');
    expect(rebound.actionOf(['chat'], ctrl('s'))).toBe('prompt.steer');
    expect(rebound.actionOf(['chat'], named('tab'))).toBeUndefined();
    expect(busyDeliveryOf(rebound, 'prompt.submit')).toBeUndefined();
    expect(busyDeliveryOf(rebound, 'prompt.queue')).toBe('queue');
    expect(busyDeliveryOf(rebound, 'prompt.steer')).toBe('steer');
  });

  it('writes the hint line from the table', () => {
    expect(busyHint(DEFAULT_KEY_TABLE, false)).toBe('enter: steer after the next tool call · tab: queue for after this run · esc: stop');
    expect(busyHint(DEFAULT_KEY_TABLE, true)).toBe('enter: steer after the next tool call · tab: queue for after this run · esc: stop · up: take back waiting messages');
    expect(busyHint(rebound, false)).toBe('ctrl+s: steer after the next tool call · ctrl+q: queue for after this run · ctrl+x: stop');
    expect(completionHint(DEFAULT_KEY_TABLE)).toBe('tab: complete · esc: close the list');
    expect(INBOX_FULL_HINT).toBe(`${INBOX_MAX_PENDING} messages are already waiting`);
  });
});

describe('the rows of the waiting messages', () => {
  it('draws one row per message in seq order, prefixed by its kind, with the first line only', () => {
    expect(waitingRows([row(2, 'steer', 'also the docs\nand more'), row(1, 'queue', 'then release')], 80)).toEqual(['queued  then release', 'steer   also the docs']);
  });

  it('truncates a row to the width with an ellipsis, by display width', () => {
    expect(waitingRows([row(1, 'queue', 'abcdefghij')], 14)).toEqual(['queued  abcde…']);
    expect(waitingRows([row(1, 'queue', 'abcdef')], 14)).toEqual(['queued  abcdef']);
    expect(waitingRows([row(1, 'steer', '日本語のテキスト')], 14)).toEqual(['steer   日本…']);
  });

  it(`draws at most ${INBOX_ROWS_SHOWN} rows and counts the rest`, () => {
    const rows = Array.from({ length: 8 }, (_, index) => row(index + 1, 'queue', `m${index + 1}`));
    expect(INBOX_ROWS_SHOWN).toBe(5);
    expect(waitingRows(rows, 80)).toEqual(['queued  m1', 'queued  m2', 'queued  m3', 'queued  m4', 'queued  m5', '+3 more waiting']);
    expect(waitingRows(rows.slice(0, 5), 80)).toHaveLength(5);
    expect(waitingRows([], 80)).toEqual([]);
  });

  it('shows no control character of a message', () => {
    expect(waitingRows([row(1, 'queue', 'a\u001b[31mb')], 80).join('')).not.toContain('\u001b');
  });
});

describe('the draft that is sent and taken back', () => {
  it('sends the whole draft and leaves an empty editor that has it in the history; a blank draft and a slash command are not sent', () => {
    const typed = insertText(emptyEditor(['old']), 'two\nlines');
    expect(draftOf(typed)).toEqual({ text: 'two\nlines', state: emptyEditor(['old', 'two\nlines']) });
    expect(draftOf(insertText(emptyEditor(), '   '))).toBeUndefined();
    expect(draftOf(insertText(emptyEditor(), ' /model x'))).toBeUndefined();
  });

  it('puts the taken-back texts before the typed text, one per line', () => {
    expect(takenBack(['one', 'two'], 'draft')).toBe('one\ntwo\ndraft');
    expect(takenBack(['one'], '')).toBe('one');
    expect(takenBack([], 'draft')).toBe('draft');
  });

  it('knows whether the caret is on the first line', () => {
    const two = insertText(emptyEditor(), 'ab\ncd');
    expect(onFirstLine(two)).toBe(false);
    expect(onFirstLine(placeCaret(two, 1))).toBe(true);
    expect(onFirstLine(emptyEditor())).toBe(true);
  });

  it('recognises the refusal of the 21st message by its code', () => {
    expect(isInboxFull(Object.assign(new Error('x'), { code: 'inbox_full' }))).toBe(true);
    expect(isInboxFull(Object.assign(new Error('x'), { code: 'conflict' }))).toBe(false);
    expect(isInboxFull(new Error('x'))).toBe(false);
    expect(isInboxFull('inbox_full')).toBe(false);
  });
});
