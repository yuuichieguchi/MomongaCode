import { describe, expect, it } from 'vitest';
import type { MemoryEvidence, MemoryKind } from '@momonga/protocol';
import type { MemoryRecord, MemoryStore, RuntimeStore } from '@momonga/store';
import { callEvent, enqueue, harness, mustClaim, newSession, recalled } from './helpers.ts';

const PROJECT = '/work/a';
const VISIBLE = { trusted: true, project: PROJECT } as const;

type Outcome = { kind: string; memory?: MemoryRecord };

type Lifecycle = MemoryStore & {
  saveCandidate(input: { scope: 'project' | 'user'; origin: 'trusted'; project: string | null; text: string; runId: string; ordinal: number; kind: MemoryKind; evidence: readonly MemoryEvidence[] }): { memory: MemoryRecord; created: boolean };
  candidates(filter?: { project?: string }): MemoryRecord[];
  accept(id: string): Outcome;
  reject(id: string): Outcome;
  markDuplicate(id: string, of: string): Outcome;
  archive(id: string): Outcome;
  restore(id: string): Outcome;
  revision(): number;
  supersededIds(): Set<string>;
  activePage(after: { createdAt: number; id: string } | null, limit: number): MemoryRecord[];
};

const lifecycleOf = (store: RuntimeStore): Lifecycle => store.memories as Lifecycle;

const started = () => {
  const { store, clock } = harness();
  const session = newSession(store, PROJECT);
  const run = enqueue(store, session.id);
  const claim = mustClaim(store, 'w1');
  expect(store.append(claim, ['c1', 'c2', 'c3', 'c4', 'c5', 'c6'].map(callEvent)).kind).toBe('ok');
  const memories = lifecycleOf(store);
  const candidate = (ordinal: number, text: string, kind: MemoryKind = 'fact') =>
    memories.saveCandidate({ scope: 'project', origin: 'trusted', project: PROJECT, text, runId: run.id, ordinal, kind, evidence: [] });
  const saved = (callId: string, text: string) => store.memories.save({ origin: 'trusted', scope: 'project', project: PROJECT, text, runId: run.id, step: 1, callId }).memory;
  return { store, clock, session, run, memories, candidate, saved };
};

const ids = (records: readonly MemoryRecord[]): string[] => records.map((record) => record.id);

describe('candidates', () => {
  it('stores a candidate with its reflection source and state', () => {
    const { session, run, candidate } = started();
    const { memory, created } = candidate(2, 'tests need a seed', 'procedure');
    expect(created).toBe(true);
    expect(memory).toMatchObject({ state: 'candidate', kind: 'procedure', text: 'tests need a seed', source: { kind: 'reflection', sessionId: session.id, runId: run.id, ordinal: 2 } });
  });

  it('is idempotent per ordinal, so a retried job adds nothing', () => {
    const { candidate } = started();
    const first = candidate(0, 'one');
    const again = candidate(0, 'one');
    expect(again.created).toBe(false);
    expect(again.memory.id).toBe(first.memory.id);
  });

  it('is never recalled, ranked, or found by a search, whichever notes the search includes', () => {
    const { store, candidate } = started();
    const { memory } = candidate(0, 'seeded fixture note');
    expect(recalled(store, VISIBLE)).toEqual([]);
    expect(store.memories.search(VISIBLE, ['seeded'])).toEqual([]);
    expect(store.memories.matchingIds(VISIBLE, ['seeded']).size).toBe(0);
    expect(store.memories.search(VISIBLE, ['seeded'], { include: 'all' })).toEqual([]);
    expect(store.memories.search(VISIBLE, [], { include: 'all' })).toEqual([]);
    expect(memory.state).toBe('candidate');
  });

  it('lists what waits for a person, per project', () => {
    const { memories, candidate, saved } = started();
    saved('c1', 'active note');
    const { memory } = candidate(0, 'waiting');
    expect(ids(memories.candidates({ project: PROJECT }))).toEqual([memory.id]);
    expect(memories.candidates({ project: '/work/other' })).toEqual([]);
  });
});

describe('accept and reject', () => {
  it('makes an accepted candidate recallable and takes it off the list', () => {
    const { store, memories, candidate } = started();
    const { memory } = candidate(0, 'waiting');
    expect(memories.accept(memory.id)).toMatchObject({ kind: 'accepted', memory: { id: memory.id, state: 'active' } });
    expect(ids(recalled(store, VISIBLE))).toEqual([memory.id]);
    expect(memories.candidates()).toEqual([]);
  });

  it('never makes a rejected candidate live', () => {
    const { store, memories, candidate } = started();
    const { memory } = candidate(0, 'waiting');
    expect(memories.reject(memory.id).kind).toBe('rejected');
    expect(recalled(store, VISIBLE)).toEqual([]);
    expect(memories.candidates()).toEqual([]);
    expect(memories.accept(memory.id).kind).not.toBe('accepted');
  });

  it('keeps a rejected candidate out of recall and plain search, finds it with all, and never restores it', () => {
    const { store, memories, candidate } = started();
    const { memory } = candidate(0, 'seeded fixture note');
    memories.reject(memory.id);
    expect(memories.get(memory.id)?.state).toBe('rejected');
    expect(recalled(store, VISIBLE)).toEqual([]);
    expect(store.memories.search(VISIBLE, ['seeded'])).toEqual([]);
    expect(ids(store.memories.search(VISIBLE, ['seeded'], { include: 'all' }))).toEqual([memory.id]);
    expect(memories.restore(memory.id).kind).toBe('not_archived');
    expect(memories.archive(memory.id).kind).toBe('not_active');
    expect(memories.get(memory.id)?.state).toBe('rejected');
  });

  it('accept sets keptAt, so a candidate that waited is not archived at once', () => {
    const { clock, memories, candidate } = started();
    const { memory } = candidate(0, 'waiting');
    clock.advance(5000);
    expect(memories.accept(memory.id).memory?.keptAt).toBe(clock.now());
  });

  it('accepts only a candidate', () => {
    const { memories, saved } = started();
    expect(memories.accept(saved('c1', 'active note').id).kind).toBe('not_candidate');
    expect(memories.accept('missing').kind).toBe('not_found');
  });
});

describe('paging for upkeep', () => {
  it('pages the active memories by creation order and id, from a cursor', () => {
    const { clock, memories, saved } = started();
    const notes = ['a', 'b', 'c', 'd', 'e'].map((text, index) => {
      clock.advance(1);
      return saved(`c${index + 1}`, text);
    });
    const first = memories.activePage(null, 2);
    expect(ids(first)).toEqual(ids(notes.slice(0, 2)));
    const second = memories.activePage({ createdAt: first[1]?.createdAt ?? 0, id: first[1]?.id ?? '' }, 2);
    expect(ids(second)).toEqual(ids(notes.slice(2, 4)));
    expect(ids(memories.activePage(null, -1))).toEqual(ids(notes));
  });

  it('leaves out what is not active or was retired, and names what a newer note replaced', () => {
    const { store, run, memories, candidate, saved } = started();
    const kept = saved('c1', 'kept');
    const archived = saved('c2', 'archived');
    memories.archive(archived.id);
    candidate(0, 'waiting');
    const replaced = saved('c3', 'old wording');
    const replacement = store.memories.save({ origin: 'trusted', scope: 'project', project: PROJECT, text: 'new', runId: run.id, step: 1, callId: 'c4', supersedes: [replaced.id] });
    expect(replacement).toBeDefined();
    expect(ids(memories.activePage(null, -1))).toEqual([kept.id, replaced.id, replacement.memory.id]);
    expect([...memories.supersededIds()]).toEqual([replaced.id]);
  });

  it('counts every write of a memory in its revision, and a read or a refused change not at all', () => {
    const { store, memories, candidate, saved } = started();
    const start = memories.revision();
    const note = saved('c1', 'one');
    expect(memories.revision()).toBe(start + 1);
    store.memories.observe(note.id, 'stale');
    memories.restore(note.id);
    expect(memories.revision()).toBe(start + 1);
    memories.archive(note.id);
    memories.restore(note.id);
    expect(memories.revision()).toBe(start + 3);
    const proposed = candidate(0, 'two');
    memories.accept(proposed.memory.id);
    expect(memories.revision()).toBe(start + 5);
    expect(store.memories.retire(note.id)?.retired).toBe(true);
    expect(memories.revision()).toBe(start + 6);
  });
});

describe('duplicate and archive', () => {
  it('records duplicate_of and hides the copy from recall, while all still finds it', () => {
    const { store, memories, saved } = started();
    const older = saved('c1', 'same text');
    const newer = saved('c2', 'same text');
    expect(memories.markDuplicate(newer.id, older.id)).toMatchObject({ memory: { state: 'duplicate', duplicateOf: older.id } });
    expect(ids(recalled(store, VISIBLE))).toEqual([older.id]);
    expect(ids(store.memories.search(VISIBLE, ['same'], { include: 'all' })).sort()).toEqual([older.id, newer.id].sort());
  });

  it('archives without deleting and restores to active', () => {
    const { store, memories, saved } = started();
    const note = saved('c1', 'old habit');
    expect(memories.archive(note.id)).toMatchObject({ memory: { state: 'archived' } });
    expect(recalled(store, VISIBLE)).toEqual([]);
    expect(store.memories.search(VISIBLE, ['habit'])).toEqual([]);
    expect(ids(store.memories.search(VISIBLE, ['habit'], { include: 'all' }))).toEqual([note.id]);
    expect(memories.restore(note.id)).toMatchObject({ kind: 'restored', memory: { state: 'active' } });
    expect(ids(recalled(store, VISIBLE))).toEqual([note.id]);
  });

  it('restore sets keptAt, so the next sweep does not archive it again', () => {
    const { clock, memories, saved } = started();
    const note = saved('c1', 'old habit');
    memories.archive(note.id);
    clock.advance(1000);
    expect(memories.restore(note.id).memory?.keptAt).toBe(clock.now());
  });

  it('restores only an archived memory', () => {
    const { memories, saved } = started();
    expect(memories.restore(saved('c1', 'active note').id).kind).toBe('not_archived');
    expect(memories.restore('missing').kind).toBe('not_found');
  });
});
