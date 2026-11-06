import { describe, expect, it } from 'vitest';
import type { RuntimeStore } from '@momonga/store';
import { START_MS, harness, rawDb } from './helpers.ts';

const addNote = (store: RuntimeStore, text: string) => store.memories.addByCommand({ scope: 'user', project: null, text, evidence: [] });

describe('memory_observations, the append-only record of evidence findings', () => {
  it('a record cannot be updated or deleted', () => {
    const { store, dbPath } = harness();
    const note = addNote(store, 'tests live in test/');
    const db = rawDb(dbPath);
    expect(db.prepare('SELECT COUNT(*) AS count FROM memory_observations WHERE memory_id = ?').get(note.id)).toEqual({ count: 1 });
    expect(() => db.prepare("UPDATE memory_observations SET status = 'stale' WHERE memory_id = ?").run(note.id)).toThrow();
    expect(() => db.prepare('DELETE FROM memory_observations WHERE memory_id = ?').run(note.id)).toThrow();
    expect(db.prepare('SELECT COUNT(*) AS count FROM memory_observations WHERE memory_id = ?').get(note.id)).toEqual({ count: 1 });
  });

  it('the first finding is appended at save', () => {
    const { store } = harness();
    const note = addNote(store, 'prefers tabs');
    expect(store.memories.observations(note.id)).toEqual([{ status: 'unbound', observedAt: START_MS }]);
  });

  it('a finding is appended only when it differs from the newest', () => {
    const { store, clock } = harness();
    const note = addNote(store, 'prefers tabs');
    clock.advance(10);
    expect(store.memories.observe(note.id, 'unbound')).toBe(false);
    clock.advance(10);
    expect(store.memories.observe(note.id, 'stale')).toBe(true);
    clock.advance(10);
    expect(store.memories.observe(note.id, 'stale')).toBe(false);
    clock.advance(10);
    expect(store.memories.observe(note.id, 'verified')).toBe(true);
    expect(store.memories.observations(note.id)).toEqual([
      { status: 'unbound', observedAt: START_MS },
      { status: 'stale', observedAt: START_MS + 20 },
      { status: 'verified', observedAt: START_MS + 40 },
    ]);
  });

  it('memories.observed_status equals the newest row and is indexed', () => {
    const { store, dbPath, clock } = harness();
    const note = addNote(store, 'prefers tabs');
    const db = rawDb(dbPath);
    const indexed = () => db.prepare('SELECT observed_status FROM memories WHERE id = ?').get(note.id)?.['observed_status'];
    expect(indexed()).toBe('unbound');
    clock.advance(5);
    store.memories.observe(note.id, 'stale');
    expect(indexed()).toBe('stale');
    expect(store.memories.get(note.id)?.observedStatus).toBe('stale');
    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'memories' AND sql LIKE '%observed_status%'").all();
    expect(indexes.length).toBeGreaterThan(0);
  });

  it('observing does not move revision()', () => {
    const { store, clock } = harness();
    const note = addNote(store, 'prefers tabs');
    const before = store.memories.revision();
    clock.advance(5);
    expect(store.memories.observe(note.id, 'stale')).toBe(true);
    expect(store.memories.revision()).toBe(before);
  });
});
