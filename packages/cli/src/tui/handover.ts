import type { EntryKey, EventKey, HandoverNote, HandoverToggles, HandoverView, TuiRecord } from '../handover/record.ts';
import type { TranscriptStore } from './screen/store.ts';
import type { Position } from './screen/viewport.ts';
import { toggleThought } from './transcript.ts';
import type { Entry } from './transcript.ts';

export type TuiSnapshot = Omit<TuiRecord, 'format' | 'fromVersion' | 'toVersion'>;

export type TuiSurface = {
  session(): string | undefined;
  quiet(): boolean;
  snapshot(): TuiSnapshot | undefined;
  suspend(): Promise<void>;
  resume(): void;
  say(text: string): void;
};

export type TuiMovePort = { attach(surface: TuiSurface): () => void; check(): void; probe(): void };

export type TuiAdoption = { record: TuiRecord; attached(): void };

export type LocalNote = Extract<Entry, { kind: 'info' | 'notice' | 'error' }>;

export const isLocalNote = (entry: Entry): entry is LocalNote => entry.kind === 'info' || entry.kind === 'notice' || entry.kind === 'error';

const BEFORE_EVENTS: EventKey = { runId: '', seq: 0 };

const sameEvent = (left: EventKey | null, right: EventKey | null): boolean => (left === null || right === null ? left === right : left.runId === right.runId && left.seq === right.seq);

const noteOf = (anchor: EventKey | null, entry: LocalNote): HandoverNote => ({ anchor, kind: entry.kind, level: entry.kind === 'notice' ? entry.level : entry.kind === 'error' ? 'error' : 'info', text: entry.text });

export const entryOfNote = (note: HandoverNote): LocalNote => (note.kind === 'notice' ? { kind: 'notice', level: note.level, text: note.text } : { kind: note.kind, text: note.text });

export type Origins = {
  at(key: EventKey): void;
  applied(): Record<string, number>;
  keyOf(entryId: number): EntryKey | null;
  entryOf(key: EntryKey): number | undefined;
  noted(entry: LocalNote, anchor?: EventKey | null): void;
  notes(): HandoverNote[];
  stop(): void;
};

const nameOf = (key: EntryKey): string => `${key.runId}\n${key.seq}\n${key.index}`;

export const createOrigins = (store: Pick<TranscriptStore, 'subscribe' | 'epoch'>): Origins => {
  let current: EventKey | null = null;
  let index = 0;
  let epoch = store.epoch();
  let applied = new Map<string, number>();
  let keys = new Map<number, EntryKey>();
  let ids = new Map<string, number>();
  let notes: HandoverNote[] = [];

  const forget = (): void => {
    epoch = store.epoch();
    current = null;
    index = 0;
    applied = new Map();
    keys = new Map();
    ids = new Map();
    notes = [];
  };

  const stop = store.subscribe((entryId) => {
    if (store.epoch() !== epoch) forget();
    if (entryId === undefined || keys.has(entryId)) return;
    const key: EntryKey = { ...(current ?? BEFORE_EVENTS), index };
    index += 1;
    keys.set(entryId, key);
    ids.set(nameOf(key), entryId);
  });

  return {
    at: (key) => {
      if (store.epoch() !== epoch) forget();
      if (!sameEvent(current, key)) {
        current = { runId: key.runId, seq: key.seq };
        index = 0;
      }
      applied.set(key.runId, Math.max(applied.get(key.runId) ?? 0, key.seq));
    },
    applied: () => Object.fromEntries(applied),
    keyOf: (entryId) => keys.get(entryId) ?? null,
    entryOf: (key) => ids.get(nameOf(key)),
    noted: (entry, anchor) => {
      if (store.epoch() !== epoch) forget();
      notes.push(noteOf(anchor === undefined ? current : anchor, entry));
    },
    notes: () => notes.map((note) => ({ ...note })),
    stop,
  };
};

export type NoteReplay = { before(): void; after(key: EventKey): void; rest(): void };

export const createNoteReplay = (notes: readonly HandoverNote[], restore: (note: HandoverNote) => void): NoteReplay => {
  let next = 0;
  const flush = (matches: (note: HandoverNote) => boolean): void => {
    for (let note = notes[next]; note !== undefined && matches(note); note = notes[next]) {
      next += 1;
      restore(note);
    }
  };
  return {
    before: () => flush((note) => note.anchor === null),
    after: (key) => flush((note) => sameEvent(note.anchor, key)),
    rest: () => flush(() => true),
  };
};

export const viewOf = (position: Position, origins: Pick<Origins, 'keyOf'>): HandoverView => ({
  key: position.anchor === undefined ? null : origins.keyOf(position.anchor.entryId),
  rowOffset: position.anchor?.rowOffset ?? 0,
  following: position.following,
});

export const positionOf = (view: HandoverView, origins: Pick<Origins, 'entryOf'>): Position => {
  const entryId = view.key === null ? undefined : origins.entryOf(view.key);
  if (entryId === undefined) return { anchor: undefined, following: view.following };
  return { anchor: { entryId, rowOffset: view.rowOffset }, following: view.following };
};

export const togglesOf = (store: Pick<TranscriptStore, 'count' | 'at'>): HandoverToggles => {
  const thoughts: Record<string, boolean> = {};
  for (let index = 0; index < store.count(); index += 1) {
    const { entry } = store.at(index);
    if (entry.kind === 'thought') thoughts[entry.itemId] = entry.expanded;
  }
  return { thoughts };
};

export const restoreToggles = (store: TranscriptStore, toggles: HandoverToggles): void => {
  const shown = togglesOf(store).thoughts;
  for (const [itemId, expanded] of Object.entries(toggles.thoughts)) {
    if (shown[itemId] !== undefined && shown[itemId] !== expanded) toggleThought(store, itemId);
  }
};
