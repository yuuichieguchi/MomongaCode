import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { GuidelineConflictError, openRuntimeStore } from '@momonga/store';
import { createFakeClock } from '@momonga/testkit';

const START_MS = 1_000;
const WINNER = { gate: 'PASS' };

const open = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-guideline-'));
  const clock = createFakeClock(START_MS);
  const store = openRuntimeStore({ path: path.join(root, 'runtime.db'), home: root, clock, leaseMs: 1_000, maxAttempts: 5, maxTotalAttempts: 50 });
  return { store, clock };
};

describe('adopting a guideline', () => {
  it('guards provenance: stores version, text, parent, adopted_at and the report', () => {
    const { store } = open();
    expect(store.guidelines.adopt({ text: 'keep names', parent: null, report: WINNER })).toEqual({
      version: 1,
      text: 'keep names',
      parent: null,
      createdAt: START_MS,
      adoptedAt: START_MS,
      report: WINNER,
    });
  });

  it('guards a skipped version: versions rise by one and each names its parent', () => {
    const { store } = open();
    store.guidelines.adopt({ text: 'a', parent: null, report: WINNER });
    expect(store.guidelines.adopt({ text: 'b', parent: 1, report: WINNER })).toMatchObject({ version: 2, parent: 1 });
    expect(store.guidelines.current()).toMatchObject({ version: 2, text: 'b' });
  });

  it('guards a lost update: a second adopt on the same parent is refused and stores nothing', () => {
    const { store } = open();
    store.guidelines.adopt({ text: 'a', parent: null, report: WINNER });
    store.guidelines.adopt({ text: 'b', parent: 1, report: WINNER });
    expect(() => store.guidelines.adopt({ text: 'c', parent: 1, report: WINNER })).toThrow(GuidelineConflictError);
    expect(store.guidelines.list().map((row) => row.text)).toEqual(['a', 'b']);
  });

  it('guards the first adoption too: two adopts with no parent do not both land', () => {
    const { store } = open();
    store.guidelines.adopt({ text: 'a', parent: null, report: WINNER });
    expect(() => store.guidelines.adopt({ text: 'b', parent: null, report: WINNER })).toThrow(GuidelineConflictError);
  });

  it('has no current guideline before the first adoption', () => {
    expect(open().store.guidelines.current()).toBeUndefined();
  });
});

describe('rolling back', () => {
  it('guards history: the return to an earlier version is a new row and earlier rows stay equal', () => {
    const { store, clock } = open();
    store.guidelines.adopt({ text: 'a', parent: null, report: WINNER });
    store.guidelines.adopt({ text: 'b', parent: 1, report: WINNER });
    const before = store.guidelines.list();
    clock.advance(5);
    const row = store.guidelines.rollback(1);
    expect(row).toEqual({ version: 3, text: 'a', parent: 2, createdAt: START_MS + 5, adoptedAt: START_MS + 5, report: { rollbackTo: 1 } });
    expect(store.guidelines.list()).toEqual([...before, row]);
    expect(store.guidelines.current()).toEqual(row);
  });

  it('refuses a version that does not exist', () => {
    const { store } = open();
    store.guidelines.adopt({ text: 'a', parent: null, report: WINNER });
    expect(() => store.guidelines.rollback(4)).toThrow(/no guideline version 4/);
    expect(store.guidelines.list()).toHaveLength(1);
  });
});

describe('context charges', () => {
  it('guards an unrecorded spend: a guideline charge has no run and belongs to its folder', () => {
    const { store } = open();
    store.contextCharges.record({ purpose: 'guideline', runId: null, project: '/p', model: 'opus', inputTokens: 7, outputTokens: 3, totalTokens: 10 });
    store.contextCharges.record({ purpose: 'guideline', runId: null, project: '/q', model: 'opus', inputTokens: 1, outputTokens: 1, totalTokens: 2 });
    expect(store.contextCharges.list({ project: '/p' })).toEqual([
      { id: 1, purpose: 'guideline', runId: null, project: '/p', model: 'opus', inputTokens: 7, outputTokens: 3, totalTokens: 10, createdAt: START_MS },
    ]);
    expect(store.contextCharges.list({})).toHaveLength(2);
  });
});
