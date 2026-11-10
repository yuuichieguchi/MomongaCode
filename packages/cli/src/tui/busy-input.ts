import { INBOX_FULL_CODE, escapeTerminalLine, inboxFullMessage } from '@momonga/protocol';
import type { ImageAttachment, InboxAddResponse, InboxDelivery, InboxRowView, InboxWithdrawResponse } from '@momonga/protocol';
import type { RunView } from '../client/views.ts';
import { emptyEditor, expandedText, pushHistory } from './editor.ts';
import type { EditorState } from './editor.ts';
import type { ActionId, KeyTable } from './keys/table.ts';
import { displayWidth, segmentsOf } from './screen/wrap.ts';

export type BusyInbox = {
  add(delivery: InboxDelivery, text: string, images?: readonly ImageAttachment[]): Promise<InboxAddResponse>;
  withdraw(id: string): Promise<InboxWithdrawResponse>;
  list(): Promise<readonly InboxRowView[]>;
  successor(runId: string): Promise<RunView | undefined>;
};

export const INBOX_ROWS_SHOWN = 5;

export const INBOX_FULL_HINT = inboxFullMessage();

const HINT_SEPARATOR = ' · ';
const ELLIPSIS = '…';
const ROW_LABELS: Readonly<Record<InboxDelivery, string>> = { queue: 'queued  ', steer: 'steer   ' };

export const busyDeliveryOf = (keys: KeyTable, action: ActionId | undefined): InboxDelivery | undefined => {
  if (action === 'prompt.steer') return 'steer';
  if (action === 'prompt.queue') return 'queue';
  if (action !== 'prompt.submit') return undefined;
  const submitKeys = keys.keysFor('prompt.submit');
  const sharesSubmitKey = (id: ActionId): boolean => keys.keysFor(id).some((spec) => submitKeys.includes(spec));
  if (sharesSubmitKey('prompt.steer')) return 'steer';
  return sharesSubmitKey('prompt.queue') ? 'queue' : undefined;
};

export const busyHint = (keys: KeyTable, waiting: boolean): string =>
  [
    `${keys.keyHint('prompt.steer')}: steer after the next tool call`,
    `${keys.keyHint('prompt.queue')}: queue for after this run`,
    `${keys.keyHint('run.stop')}: stop`,
    ...(waiting ? [`${keys.keyHint('editor.up')}: take back waiting messages`] : []),
  ].join(HINT_SEPARATOR);

export const completionHint = (keys: KeyTable): string => [`${keys.keyHint('menu.complete')}: complete`, `${keys.keyHint('menu.close')}: close the list`].join(HINT_SEPARATOR);

const truncated = (text: string, width: number): string => {
  if (displayWidth(text) <= width) return text;
  const room = width - displayWidth(ELLIPSIS);
  let used = 0;
  let kept = '';
  for (const { segment, width: segmentWidth } of segmentsOf(text)) {
    if (used + segmentWidth > room) break;
    used += segmentWidth;
    kept += segment;
  }
  return `${kept}${ELLIPSIS}`;
};

const firstLineOf = (text: string): string => text.split('\n', 1)[0] ?? '';

export const waitingRows = (pending: readonly InboxRowView[], width: number): string[] => {
  const ordered = pending.toSorted((left, right) => left.seq - right.seq);
  const drawn = ordered.slice(0, INBOX_ROWS_SHOWN).map((row) => truncated(`${ROW_LABELS[row.delivery]}${escapeTerminalLine(firstLineOf(row.text))}`, width));
  const rest = ordered.length - drawn.length;
  return rest > 0 ? [...drawn, `+${rest} more waiting`] : drawn;
};

export const draftOf = (state: EditorState): { text: string; state: EditorState } | undefined => {
  const text = expandedText(state);
  if (text.trim() === '' || text.trim().startsWith('/')) return undefined;
  return { text, state: emptyEditor(pushHistory(state.history, text)) };
};

export const takenBack = (texts: readonly string[], draft: string): string => [...texts, ...(draft === '' ? [] : [draft])].join('\n');

export const onFirstLine = (state: EditorState): boolean => !state.text.slice(0, state.cursor).includes('\n');

export const isInboxFull = (error: unknown): boolean => error instanceof Error && 'code' in error && error.code === INBOX_FULL_CODE;
