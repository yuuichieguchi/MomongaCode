import type { MemoryView } from '@momonga/protocol';
import { normalizeMemoryText } from './normalize-text.ts';

export const DAY_MS = 86_400_000;

export type DuplicateNote = Pick<MemoryView, 'id' | 'text' | 'scope' | 'project' | 'origin' | 'createdAt' | 'state'>;

export type UpkeepNote = Pick<MemoryView, 'id' | 'keptAt' | 'contributedAt' | 'status' | 'state'>;

export type DuplicateMark = { id: string; duplicateOf: string };

export type DuplicateKeepers = Map<string, string>;

export const duplicateMarks = (notes: readonly DuplicateNote[], keepers: DuplicateKeepers = new Map()): DuplicateMark[] => {
  const oldestFirst = notes.filter((note) => note.state === 'active').sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const marks: DuplicateMark[] = [];
  for (const note of oldestFirst) {
    const key = JSON.stringify([note.scope, note.project, note.origin, normalizeMemoryText(note.text)]);
    const keeper = keepers.get(key);
    if (keeper === undefined || keeper === note.id) keepers.set(key, note.id);
    else marks.push({ id: note.id, duplicateOf: keeper });
  }
  return marks;
};

export type ForgetWindow = { now: number; forgetAfterDays: number };

export const isIdleBeyondWindow = (note: Pick<UpkeepNote, 'keptAt' | 'contributedAt'>, window: ForgetWindow): boolean =>
  window.now - Math.max(note.keptAt, note.contributedAt ?? note.keptAt) >= window.forgetAfterDays * DAY_MS;

export const archivableIds = (notes: readonly UpkeepNote[], window: ForgetWindow): string[] =>
  notes
    .filter((note) => note.state === 'active' && (note.status === 'stale' || note.status === 'unbound') && isIdleBeyondWindow(note, window))
    .map((note) => note.id);
