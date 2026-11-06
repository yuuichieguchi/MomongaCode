import { StatementSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { recallOrder } from '@momonga/memory';
import { MEMORY_STATUSES } from '@momonga/protocol';
import type { MemoryStatus } from '@momonga/protocol';
import type { MemoryRecord, RuntimeStore } from '@momonga/store';
import { harness, rawDb } from './helpers.ts';

const PROJECT = '/work/a';

const VISIBLE = { trusted: true, project: PROJECT } as const;

const seededRandom = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
};

const addNote = (store: RuntimeStore, text: string, evidenceCount = 0): MemoryRecord =>
  store.memories.addByCommand({
    scope: 'project',
    project: PROJECT,
    text,
    evidence: Array.from({ length: evidenceCount }, (_unused, index) => ({ kind: 'file' as const, project: PROJECT, path: `src/f${index}.ts`, sha256: 'b'.repeat(64) })),
  });

const walk = (store: RuntimeStore, terms: readonly string[], limit: number): string[] => {
  const seen: string[] = [];
  let after: ReturnType<RuntimeStore['memories']['recallPage']>['next'] = null;
  for (let pages = 0; pages < 1000; pages += 1) {
    const page = store.memories.recallPage(VISIBLE, { terms, after, limit });
    expect(page.memories.length).toBeLessThanOrEqual(limit);
    seen.push(...page.memories.map((memory) => memory.id));
    if (page.next === null) return seen;
    after = page.next;
  }
  throw new Error('the cursor never ended');
};

const STATEMENT_METHODS = ['all', 'get', 'run', 'iterate'] as const;

const countStatements = <T>(action: () => T): { result: T; statements: number } => {
  const spies = STATEMENT_METHODS.map((method) => vi.spyOn(StatementSync.prototype, method));
  try {
    const result = action();
    return { result, statements: spies.reduce((sum, spy) => sum + spy.mock.calls.length, 0) };
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the recall page', () => {
  it('a page holds at most the asked rows and decodes evidence in two statements', () => {
    const small = harness();
    for (let index = 0; index < 3; index += 1) addNote(small.store, `note ${index}`, 2);
    const large = harness();
    for (let index = 0; index < 30; index += 1) addNote(large.store, `note ${index}`, 2);
    const smallPage = countStatements(() => small.store.memories.recallPage(VISIBLE, { terms: [], after: null, limit: 50 }));
    const largePage = countStatements(() => large.store.memories.recallPage(VISIBLE, { terms: [], after: null, limit: 50 }));
    expect(smallPage.result.memories).toHaveLength(3);
    expect(largePage.result.memories).toHaveLength(30);
    expect(largePage.result.memories.every((memory) => memory.evidence.length === 2)).toBe(true);
    expect(largePage.statements).toBe(smallPage.statements);
    expect(largePage.statements).toBeLessThanOrEqual(4);
    const limited = large.store.memories.recallPage(VISIBLE, { terms: [], after: null, limit: 7 });
    expect(limited.memories).toHaveLength(7);
    expect(limited.next).not.toBeNull();
  });

  it('the keyset cursor walks the whole order with no repeat and no gap', () => {
    const { store, clock } = harness();
    const random = seededRandom(7);
    const notes: MemoryRecord[] = [];
    for (let index = 0; index < 25; index += 1) {
      clock.advance(Math.floor(random() * 3));
      notes.push(addNote(store, `${index % 3 === 0 ? 'parser' : 'lexer'} note ${index}`));
    }
    const walked = walk(store, ['parser'], 4);
    expect(new Set(walked).size).toBe(walked.length);
    expect([...walked].sort()).toEqual(notes.map((note) => note.id).sort());
    expect(walked).toEqual(walk(store, ['parser'], 100));
  });

  it('the SQL order equals recallOrder on the same data', () => {
    const { store, clock } = harness();
    const random = seededRandom(20261106);
    const terms = ['parser'];
    const created: MemoryRecord[] = [];
    for (let index = 0; index < 60; index += 1) {
      clock.advance(Math.floor(random() * 2));
      created.push(addNote(store, `${random() < 0.3 ? 'parser' : 'lexer'} note ${index}`));
    }
    for (const note of created) {
      clock.advance(1);
      const status = MEMORY_STATUSES[Math.floor(random() * MEMORY_STATUSES.length)] as MemoryStatus;
      store.memories.observe(note.id, status);
      if (random() < 0.5) store.memories.stampContributed([note.id], 1_000 + Math.floor(random() * 4));
    }
    const records = created.map((note) => store.memories.get(note.id) as MemoryRecord);
    const matched = new Set(records.filter((record) => record.text.startsWith('parser')).map((record) => record.id));
    expect(walk(store, terms, 9)).toEqual(recallOrder(records, matched).map((record) => record.id));
  });

  it('a note never observed sorts after every tier', () => {
    const { store, dbPath, clock } = harness();
    clock.advance(1);
    const stale = addNote(store, 'found stale');
    store.memories.observe(stale.id, 'stale');
    const db = rawDb(dbPath);
    db.prepare('CREATE TEMP TABLE one_copy AS SELECT * FROM memories WHERE id = ?').run(stale.id);
    db.exec("UPDATE one_copy SET id = 'never-observed', text = 'never observed', observed_status = NULL");
    db.exec('INSERT INTO memories SELECT * FROM one_copy');
    expect(db.prepare("SELECT COUNT(*) AS count FROM memory_observations WHERE memory_id = 'never-observed'").get()).toEqual({ count: 0 });
    expect(store.memories.get('never-observed')?.observedStatus).toBeNull();
    expect(walk(store, [], 10)).toEqual([stale.id, 'never-observed']);
  });
});
