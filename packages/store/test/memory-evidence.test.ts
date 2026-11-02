import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { MemoryEvidence } from '@momonga/protocol';
import type { RuntimeStore, SaveMemoryInput } from '@momonga/store';
import { callEvent, enqueue, harness, mustClaim, newSession } from './helpers.ts';

const CALLS = ['c1', 'c2', 'c3', 'c4', 'c5'];

const started = () => {
  const { store, clock } = harness();
  const session = newSession(store, '/work/a');
  const run = enqueue(store, session.id);
  const claim = mustClaim(store, 'w1');
  expect(store.append(claim, CALLS.map(callEvent)).kind).toBe('ok');
  return { store, clock, run };
};

const save = (store: RuntimeStore, runId: string, callId: string, text: string, overrides: Partial<SaveMemoryInput> = {}) =>
  store.memories.save({ origin: 'trusted', scope: 'project', project: '/work/a', text, runId, step: 1, callId, ...overrides }).memory;

const EVIDENCE: MemoryEvidence[] = [
  { kind: 'file', project: '/work/a', path: 'src/a.ts', sha256: 'aa' },
  { kind: 'commit', sha: 'bb' },
  { kind: 'check', runId: 'r1', callId: 'c1', seq: 3, command: 'npm test', exitCode: 0 },
];

const VISIBLE = { trusted: true, project: '/work/a' } as const;

describe('saving', () => {
  it('stores kind, supersedes and evidence in order', () => {
    const { store, run } = started();
    const older = save(store, run.id, 'c1', 'older');
    const memory = save(store, run.id, 'c2', 'newer', { kind: 'procedure', supersedes: [older.id], evidence: EVIDENCE });
    expect(store.memories.get(memory.id)).toMatchObject({ kind: 'procedure', supersedes: [older.id], evidence: EVIDENCE });
  });

  it('keeps status out of the record, because status is computed at read', () => {
    const { store, run } = started();
    expect(save(store, run.id, 'c1', 'note')).not.toHaveProperty('status');
  });

  it('does not add evidence twice for a replayed call', () => {
    const { store, run } = started();
    const input: SaveMemoryInput = { origin: 'trusted', scope: 'project', project: '/work/a', text: 'x', runId: run.id, step: 1, callId: 'c1', evidence: EVIDENCE };
    store.memories.save(input);
    expect(store.memories.save(input).memory.evidence).toEqual(EVIDENCE);
  });
});

describe('recall', () => {
  it('leaves out a superseded memory and a retired one, and history shows them', () => {
    const { store, run } = started();
    const older = save(store, run.id, 'c1', 'older');
    const newer = save(store, run.id, 'c2', 'newer', { supersedes: [older.id] });
    const retired = save(store, run.id, 'c3', 'retired');
    store.memories.retire(retired.id);
    expect(store.memories.recall(VISIBLE).map((memory) => memory.id)).toEqual([newer.id]);
    expect(store.memories.history(newer.id).map((memory) => memory.id)).toEqual([older.id, newer.id]);
    expect(store.memories.history(older.id).map((memory) => memory.id)).toEqual([older.id, newer.id]);
  });
});

describe('search', () => {
  it('replaces the substring filter with the index', () => {
    const source = fs.readFileSync(path.join(import.meta.dirname, '../src/memories.ts'), 'utf8');
    expect(source).toContain('memories_index');
    expect(source).not.toMatch(/\.includes\(needle\)/);
  });

  it('matches a mid-word substring through the trigram index', () => {
    const { store, run } = started();
    const memory = save(store, run.id, 'c1', 'the tokenizer lives here');
    expect(store.memories.search(VISIBLE, ['okeni']).map((entry) => entry.id)).toEqual([memory.id]);
  });

  it('requires every term', () => {
    const { store, run } = started();
    const both = save(store, run.id, 'c1', 'alpha and bravo');
    save(store, run.id, 'c2', 'alpha only');
    expect(store.memories.search(VISIBLE, ['alpha', 'bravo']).map((entry) => entry.id)).toEqual([both.id]);
  });

  it('treats a query as text, never as FTS syntax', () => {
    const { store, run } = started();
    const memory = save(store, run.id, 'c1', 'use "quotes" OR NOT stars*');
    expect(store.memories.search(VISIBLE, ['"quotes"']).map((entry) => entry.id)).toEqual([memory.id]);
    expect(store.memories.search(VISIBLE, ['NEAR(a b)'])).toEqual([]);
    expect(store.memories.search(VISIBLE, ['stars*']).map((entry) => entry.id)).toEqual([memory.id]);
  });

  it('finds a term shorter than three characters, as in Japanese', () => {
    const { store, run } = started();
    const memory = save(store, run.id, 'c1', '仕様を確認した');
    save(store, run.id, 'c2', 'unrelated');
    expect(store.memories.search(VISIBLE, ['仕様']).map((entry) => entry.id)).toEqual([memory.id]);
  });

  it('leaves out superseded and retired memories by default and shows them with include all', () => {
    const { store, run } = started();
    const older = save(store, run.id, 'c1', 'shared word');
    const newer = save(store, run.id, 'c2', 'shared word again', { supersedes: [older.id] });
    const retired = save(store, run.id, 'c3', 'shared word retired');
    store.memories.retire(retired.id);
    expect(store.memories.search(VISIBLE, ['shared']).map((entry) => entry.id)).toEqual([newer.id]);
    expect(store.memories.search(VISIBLE, ['shared'], { include: 'all' }).map((entry) => entry.id).sort()).toEqual([older.id, newer.id, retired.id].sort());
  });

  it('says on a replaced note which notes replaced it, and not on the one that replaced it', () => {
    const { store, run } = started();
    const older = save(store, run.id, 'c1', 'shared word');
    const newer = save(store, run.id, 'c2', 'shared word again', { supersedes: [older.id] });
    expect(store.memories.get(older.id)?.supersededBy).toEqual([newer.id]);
    expect(store.memories.get(newer.id)?.supersededBy).toEqual([]);
    expect(store.memories.search(VISIBLE, ['shared'], { include: 'all' }).map((entry) => [entry.id, entry.supersededBy])).toEqual(
      expect.arrayContaining([[older.id, [newer.id]], [newer.id, []]]),
    );
  });

  it('keeps visibility with include all: another project stays hidden', () => {
    const { store, run } = started();
    save(store, run.id, 'c1', 'shared word', { project: '/work/b' });
    expect(store.memories.search(VISIBLE, ['shared'], { include: 'all' })).toEqual([]);
    expect(store.memories.search({ trusted: false }, ['shared'], { include: 'all' })).toEqual([]);
  });
});

describe('matchingIds', () => {
  it('gives the ids matching any term, for the first rank of recall', () => {
    const { store, run } = started();
    const first = save(store, run.id, 'c1', 'touches src/parser.ts');
    const second = save(store, run.id, 'c2', 'about the sweeper');
    save(store, run.id, 'c3', 'nothing else');
    expect([...store.memories.matchingIds(VISIBLE, ['parser.ts', 'sweeper'])].sort()).toEqual([first.id, second.id].sort());
  });

  it('is not widened to almost every note by a one-letter word of the task', () => {
    const { store, run } = started();
    const wanted = save(store, run.id, 'c1', 'the bug lives in the sweeper');
    save(store, run.id, 'c2', 'banana bread recipe');
    save(store, run.id, 'c3', 'a gardening note');
    expect([...store.memories.matchingIds(VISIBLE, ['fix', 'a', 'bug'])]).toEqual([wanted.id]);
  });

  it('still matches a short word when it is the whole query, and a two-character Japanese word beside others', () => {
    const { store, run } = started();
    const letter = save(store, run.id, 'c1', 'x marks the spot');
    const japanese = save(store, run.id, 'c2', '設計の方針');
    save(store, run.id, 'c3', 'unrelated');
    expect([...store.memories.matchingIds(VISIBLE, ['x'])]).toEqual([letter.id]);
    expect([...store.memories.matchingIds(VISIBLE, ['設計', 'parser'])]).toEqual([japanese.id]);
  });
});
