import { describe, expect, it } from 'vitest';
import * as memory from '@momonga/memory';

const DAY_MS = 86_400_000;
const NOW = 1_800_000_000_000;
const FORGET_DAYS = 90;
const FORGET_MS = 7_776_000_000;

type Note = {
  id: string;
  text: string;
  scope: 'user' | 'project';
  project: string | null;
  createdAt: number;
  lastUsedAt: number;
  contributedAt: number | null;
  status: 'verified' | 'unbound' | 'unverifiable' | 'stale';
  state: 'active' | 'candidate' | 'archived' | 'duplicate';
};

const note = (id: string, overrides: Partial<Note> = {}): Note => ({
  id,
  text: `text of ${id}`,
  scope: 'project',
  project: '/work/a',
  createdAt: 1,
  lastUsedAt: 1,
  contributedAt: null,
  status: 'unbound',
  state: 'active',
  ...overrides,
});

const exported = (name: string): ((...args: unknown[]) => unknown) => {
  const found = (memory as Record<string, unknown>)[name];
  if (typeof found !== 'function') throw new Error(`@momonga/memory does not export ${name}`);
  return found as (...args: unknown[]) => unknown;
};

const duplicates = (notes: readonly Note[]) => exported('duplicateMarks')(notes) as { id: string; duplicateOf: string }[];

const archivable = (notes: readonly Note[], now = NOW) => exported('archivableIds')(notes, { now, forgetAfterDays: FORGET_DAYS }) as string[];

const idle = (overrides: Partial<Note> = {}): Partial<Note> => ({ lastUsedAt: NOW - FORGET_MS, ...overrides });

describe('duplicateMarks', () => {
  it('marks the newer of two equal notes and keeps the older id', () => {
    const notes = [note('newer', { text: 'use X', createdAt: 20 }), note('older', { text: 'use X', createdAt: 10 })];
    expect(duplicates(notes)).toEqual([{ id: 'newer', duplicateOf: 'older' }]);
  });

  it('points every copy at the oldest one', () => {
    const notes = [note('a', { text: 'same', createdAt: 1 }), note('b', { text: 'same', createdAt: 2 }), note('c', { text: 'same', createdAt: 3 })];
    expect(duplicates(notes)).toEqual([
      { id: 'b', duplicateOf: 'a' },
      { id: 'c', duplicateOf: 'a' },
    ]);
  });

  it('never merges by containment, because use X is not do not use X', () => {
    expect(duplicates([note('a', { text: 'use X', createdAt: 1 }), note('b', { text: 'do not use X', createdAt: 2 })])).toEqual([]);
  });

  it('never merges across projects or scopes', () => {
    const notes = [
      note('a', { text: 'same', createdAt: 1 }),
      note('b', { text: 'same', createdAt: 2, project: '/work/b' }),
      note('c', { text: 'same', createdAt: 3, scope: 'user', project: null }),
    ];
    expect(duplicates(notes)).toEqual([]);
  });

  it('ignores a candidate, which is a proposal and not a live memory', () => {
    expect(duplicates([note('a', { text: 'same', createdAt: 1 }), note('b', { text: 'same', createdAt: 2, state: 'candidate' })])).toEqual([]);
  });
});

describe('archivableIds', () => {
  it.each(['stale', 'unbound'] as const)('archives a %s note idle for exactly forgetAfterDays', (status) => {
    expect(archivable([note('a', idle({ status }))])).toEqual(['a']);
  });

  it('keeps a note one millisecond short of the limit', () => {
    expect(archivable([note('a', { lastUsedAt: NOW - FORGET_MS + 1 })])).toEqual([]);
  });

  it.each(['verified', 'unverifiable'] as const)('never archives a %s note', (status) => {
    expect(archivable([note('a', idle({ status }))])).toEqual([]);
  });

  it('keeps a note that contributed inside the window, though its last use is old', () => {
    expect(archivable([note('a', idle({ contributedAt: NOW - DAY_MS }))])).toEqual([]);
  });

  it('archives a note whose contribution is older than the window', () => {
    expect(archivable([note('a', idle({ contributedAt: NOW - FORGET_MS }))])).toEqual(['a']);
  });

  it.each(['candidate', 'duplicate', 'archived'] as const)('leaves a %s note alone', (state) => {
    expect(archivable([note('a', idle({ state }))])).toEqual([]);
  });
});
