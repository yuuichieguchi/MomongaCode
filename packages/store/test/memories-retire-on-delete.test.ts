import { describe, expect, it } from 'vitest';
import type { MemoryRecord, RuntimeStore } from '@momonga/store';
import { callEvent, enqueue, harness, mustClaim, newSession, rawDb } from './helpers.ts';

const PROJECT = '/work/a';

const VISIBLE = { trusted: true, project: PROJECT } as const;

const started = (store: RuntimeStore, callIds: readonly string[]) => {
  const session = newSession(store, PROJECT);
  const run = enqueue(store, session.id);
  const claim = mustClaim(store, 'w1');
  expect(store.append(claim, callIds.map(callEvent)).kind).toBe('ok');
  return run;
};

const saveNote = async (store: RuntimeStore, runId: string, callId: string, text: string, supersedes: string[] = []): Promise<MemoryRecord> =>
  (await store.memories.save({
    origin: 'trusted',
    scope: 'project',
    project: PROJECT,
    text,
    runId,
    step: 1,
    callId,
    evidence: [{ kind: 'file', project: PROJECT, path: 'src/a.ts', sha256: 'a'.repeat(64) }],
    supersedes,
  })).memory;

const recalledIds = (store: RuntimeStore): string[] => store.memories.recallPage(VISIBLE, { terms: [], after: null, limit: 100 }).memories.map((memory) => memory.id);

const ROW_REMOVAL_REFUSED = /memories are retired, not deleted/;

describe('a memory is retired, never deleted', () => {
  it('DELETE FROM memories is refused by the database', async () => {
    const { store, dbPath } = harness();
    const run = started(store, ['c1']);
    const note = await saveNote(store, run.id, 'c1', 'tests live in test/');
    const db = rawDb(dbPath);
    expect(() => db.prepare('DELETE FROM memories WHERE id = ?').run(note.id)).toThrow(ROW_REMOVAL_REFUSED);
    expect(store.memories.get(note.id)?.text).toBe('tests live in test/');
    expect(db.prepare('SELECT COUNT(*) AS count FROM memory_evidence WHERE memory_id = ?').get(note.id)).toEqual({ count: 1 });
  });

  it('delete retires: the row, its text and its evidence remain', async () => {
    const { store } = harness();
    const run = started(store, ['c1']);
    const note = await saveNote(store, run.id, 'c1', 'tests live in test/');
    expect('delete' in store.memories).toBe(false);
    const retired = store.memories.retire(note.id);
    expect(retired?.retired).toBe(true);
    expect(store.memories.get(note.id)).toMatchObject({ id: note.id, text: 'tests live in test/', evidence: note.evidence });
    expect(store.memories.get(note.id)?.retiredAt).not.toBeNull();
  });

  it('a retired note is not recalled, and shown by history with retiredAt', async () => {
    const { store, clock } = harness();
    const run = started(store, ['c1', 'c2']);
    const note = await saveNote(store, run.id, 'c1', 'tests live in test/');
    const other = await saveNote(store, run.id, 'c2', 'docs live in docs/');
    clock.advance(500);
    const retiredAt = clock.now();
    store.memories.retire(note.id);
    expect(recalledIds(store)).toEqual([other.id]);
    expect(store.memories.history(note.id).map((entry) => [entry.id, entry.retiredAt])).toEqual([[note.id, retiredAt]]);
  });

  it('deleting the successor does not revive the note it replaced', async () => {
    const { store, dbPath } = harness();
    const run = started(store, ['c1', 'c2']);
    const replaced = await saveNote(store, run.id, 'c1', 'old wording');
    const successor = await saveNote(store, run.id, 'c2', 'new wording', [replaced.id]);
    expect(recalledIds(store)).toEqual([successor.id]);
    const db = rawDb(dbPath);
    expect(() => db.prepare('DELETE FROM memories WHERE id = ?').run(successor.id)).toThrow(ROW_REMOVAL_REFUSED);
    store.memories.retire(successor.id);
    expect(recalledIds(store)).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS count FROM memory_replacements WHERE successor_id = ?').get(successor.id)).toEqual({ count: 1 });
  });

  it('deleting the middle of a chain of three keeps the chain in history', async () => {
    const { store, dbPath, clock } = harness();
    const run = started(store, ['c1', 'c2', 'c3']);
    const first = await saveNote(store, run.id, 'c1', 'first wording');
    clock.advance(1);
    const middle = await saveNote(store, run.id, 'c2', 'second wording', [first.id]);
    clock.advance(1);
    const last = await saveNote(store, run.id, 'c3', 'third wording', [middle.id]);
    const db = rawDb(dbPath);
    expect(() => db.prepare('DELETE FROM memories WHERE id = ?').run(middle.id)).toThrow(ROW_REMOVAL_REFUSED);
    store.memories.retire(middle.id);
    expect(store.memories.history(first.id).map((entry) => entry.id)).toEqual([first.id, middle.id, last.id]);
    expect(recalledIds(store)).toEqual([last.id]);
  });
});
