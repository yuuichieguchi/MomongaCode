import { useEffect, useEffectEvent, useReducer, useRef } from 'react';
import type { FileCandidates } from '@momonga/foundation';
import type { AttachmentSummary } from '@momonga/protocol';
import type { EditorState } from './editor.ts';
import type { KeyTable } from './keys/table.ts';
import type { MenuAction } from './screen/menu.tsx';

export const AT_LIST_ROWS = 8;
export const RANK_UNIT = 2000;

export type MentionToken = { start: number; query: string; quoted: boolean };

const OPEN_TOKEN = /(?:^|\s)@("[^"\n]*|[^\s"]*)$/;
const WHOLE_TOKEN = /(?:^|\s)@(?:"[^"\n]+"|[^\s"`]+)/;
const WHITESPACE = /\s/;

export const mentionTokenAt = (text: string, cursor: number): MentionToken | undefined => {
  const match = OPEN_TOKEN.exec(text.slice(0, cursor));
  const typed = match?.[1];
  if (typed === undefined) return undefined;
  const quoted = typed.startsWith('"');
  return { start: cursor - typed.length - 1, query: quoted ? typed.slice(1) : typed, quoted };
};

export const hasMentionToken = (text: string): boolean => WHOLE_TOKEN.test(text);

export const candidatePathsOf = (files: readonly string[]): string[] => {
  const paths = new Set<string>();
  for (const file of files) {
    for (let slash = file.indexOf('/'); slash !== -1; slash = file.indexOf('/', slash + 1)) paths.add(file.slice(0, slash + 1));
    paths.add(file);
  }
  return [...paths];
};

const isDirectory = (entry: string): boolean => entry.endsWith('/');

const baseNameOf = (entry: string): string => {
  const trimmed = isDirectory(entry) ? entry.slice(0, -1) : entry;
  return trimmed.slice(trimmed.lastIndexOf('/') + 1);
};

const isSubsequence = (needle: string, text: string): boolean => {
  let at = 0;
  for (const char of needle) {
    at = text.indexOf(char, at);
    if (at === -1) return false;
    at += 1;
  }
  return true;
};

const LENGTH_WEIGHT = 100_000;

export const scoreOf = (entry: string, query: string): number | undefined => {
  if (entry.startsWith('.') && !query.startsWith('.')) return undefined;
  const text = entry.toLowerCase();
  const wanted = query.toLowerCase();
  const rank = text.startsWith(wanted) ? 0 : baseNameOf(text).startsWith(wanted) ? 1 : text.includes(wanted) ? 2 : isSubsequence(wanted, text) ? 3 : undefined;
  return rank === undefined ? undefined : rank * LENGTH_WEIGHT + entry.length;
};

type Scored = { entry: string; score: number };

const better = (left: Scored, right: Scored): boolean => left.score < right.score || (left.score === right.score && left.entry < right.entry);

export type RankTerms = { limit: number; pause(): Promise<void>; cancelled(): boolean };

export const rankCandidates = async (entries: readonly string[], query: string, { limit, pause, cancelled }: RankTerms): Promise<string[] | undefined> => {
  const best: Scored[] = [];
  for (let from = 0; from < entries.length; from += RANK_UNIT) {
    if (from > 0) await pause();
    if (cancelled()) return undefined;
    for (const entry of entries.slice(from, from + RANK_UNIT)) {
      const score = scoreOf(entry, query);
      if (score === undefined) continue;
      const scored = { entry, score };
      const worst = best.at(-1);
      if (best.length === limit && worst !== undefined && !better(scored, worst)) continue;
      const at = best.findIndex((kept) => better(scored, kept));
      best.splice(at === -1 ? best.length : at, 0, scored);
      if (best.length > limit) best.pop();
    }
  }
  return best.map((kept) => kept.entry);
};

export const completedMention = (text: string, cursor: number, token: MentionToken, path: string): { text: string; cursor: number } => {
  const spaced = WHITESPACE.test(path);
  const open = isDirectory(path);
  const written = spaced ? `@"${path}${open ? '' : '"'}` : `@${path}`;
  const placed = `${written}${open ? '' : ' '}`;
  return { text: `${text.slice(0, token.start)}${placed}${text.slice(cursor)}`, cursor: token.start + placed.length };
};

export const attachSwitchLabel = (on: boolean, keys: KeyTable): string => `Attach file contents: ${on ? 'on' : 'off'} (${keys.keyHint('menu.run')} to turn ${on ? 'off' : 'on'})`;

export const NO_IMAGE_INPUT_HINT = 'This model does not accept images';
export const NO_CLIPBOARD_PROGRAM_HINT = 'No program to read the clipboard was found';

export const imageSpanLabel = (number: number): string => `[Image #${number}]`;

export const attachedRow = (summary: Extract<AttachmentSummary, { type: 'attached_file' }>): string => `attached ${summary.path} (${summary.lines} lines)`;

export type AtAct = { readonly kind: 'handled' } | { readonly kind: 'place'; readonly text: string; readonly cursor: number } | { readonly kind: 'toggle' };

export type AtMenu = {
  open: boolean;
  rows: number;
  labels: readonly string[];
  index: number;
  act(editor: EditorState, action: MenuAction): AtAct | undefined;
  press(editor: EditorState, row: number): AtAct | undefined;
};

export type AtMenuHost = {
  editor: EditorState;
  active: boolean;
  attachOn: boolean;
  rowsCap: number;
  keys: KeyTable;
  candidates(signal: AbortSignal): Promise<FileCandidates>;
  pause(): Promise<void>;
  reportError(error: unknown): void;
};

type Listed = { key: string; paths: readonly string[] };

const keyOf = (token: MentionToken): string => `${token.start}:${token.query}`;

export const useAtMenu = (host: AtMenuHost): AtMenu => {
  const token = host.active ? mentionTokenAt(host.editor.text, host.editor.cursor) : undefined;
  const key = token === undefined ? undefined : keyOf(token);
  const listed = useRef<Listed | undefined>(undefined);
  const held = useRef<{ key: string | undefined; index: number; closed: string | undefined }>({ key: undefined, index: 0, closed: undefined });
  const [, redraw] = useReducer((count: number) => count + 1, 0);
  const generation = useRef(0);
  const limit = Math.max(1, Math.min(AT_LIST_ROWS, host.rowsCap) - 1);

  const list = useEffectEvent(async (wanted: MentionToken, signal: AbortSignal): Promise<void> => {
    generation.current += 1;
    const mine = generation.current;
    const stale = (): boolean => signal.aborted || generation.current !== mine;
    try {
      const found = await host.candidates(signal);
      if (stale()) return;
      const paths = await rankCandidates(candidatePathsOf(found.entries), wanted.query, { limit, pause: host.pause, cancelled: stale });
      if (paths === undefined || stale()) return;
      listed.current = { key: keyOf(wanted), paths };
      redraw();
    } catch (error) {
      if (!stale()) host.reportError(error);
    }
  });

  useEffect(() => {
    if (token === undefined) return undefined;
    const job = new AbortController();
    void list(token, job.signal);
    return () => job.abort();
  }, [key]);

  type Shown = { token: MentionToken; key: string; paths: readonly string[]; index: number; labels: readonly string[] };

  const shownFor = (editor: EditorState): Shown | undefined => {
    const at = host.active ? mentionTokenAt(editor.text, editor.cursor) : undefined;
    if (at === undefined) return undefined;
    const atKey = keyOf(at);
    const found = listed.current;
    if (found === undefined || found.key !== atKey || found.paths.length === 0 || held.current.closed === atKey) return undefined;
    const labels = [...found.paths.map((path) => `@${path}`), attachSwitchLabel(host.attachOn, host.keys)];
    return { token: at, key: atKey, paths: found.paths, index: held.current.key === atKey ? Math.min(held.current.index, found.paths.length) : 0, labels };
  };

  const keep = (next: { key: string; index: number; closed: string | undefined }): void => {
    held.current = next;
    redraw();
  };

  const chosen = (editor: EditorState, shown: Shown, at: number): AtAct => {
    const path = shown.paths[at];
    return path === undefined ? { kind: 'toggle' } : { kind: 'place', ...completedMention(editor.text, editor.cursor, shown.token, path) };
  };

  const shown = shownFor(host.editor);

  return {
    open: shown !== undefined,
    rows: shown === undefined ? 0 : shown.labels.length,
    labels: shown === undefined ? [] : shown.labels,
    index: shown === undefined ? 0 : shown.index,
    act: (editor, action) => {
      const current = shownFor(editor);
      if (current === undefined) return undefined;
      if (action === 'menu.close') {
        keep({ key: current.key, index: current.index, closed: current.key });
        return { kind: 'handled' };
      }
      if (action === 'menu.up' || action === 'menu.down') {
        keep({ key: current.key, index: (current.index + (action === 'menu.up' ? current.labels.length - 1 : 1)) % current.labels.length, closed: held.current.closed });
        return { kind: 'handled' };
      }
      return chosen(editor, current, current.index);
    },
    press: (editor, row) => {
      const current = shownFor(editor);
      return current === undefined || row >= current.labels.length ? undefined : chosen(editor, current, row);
    },
  };
};
