import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { GuidelineConflictError, GuidelineTextError, openRuntimeStore } from '@momonga/store';
import { createFakeClock, testKernelLock } from '@momonga/testkit';
import { UNASKED_COMMANDS } from './helpers.ts';
import { BUSY_WAIT_LIMIT_MS } from '@momonga/foundation';

const START_MS = 1_000;
const WINNER = { gate: 'PASS' };
const BIDIRECTIONAL_CONTROLS = ['061C', '200E', '200F', '202A', '202B', '202C', '202D', '202E', '2066', '2067', '2068', '2069'];

const open = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-guideline-'));
  const clock = createFakeClock(START_MS);
  const store = openRuntimeStore({ busyTimeoutMs: BUSY_WAIT_LIMIT_MS, lock: testKernelLock(), unaskedCommands: UNASKED_COMMANDS, path: path.join(root, 'runtime.db'), home: root, clock, leaseMs: 1_000, maxAttempts: 5, maxTotalAttempts: 50 });
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

  it.each([
    ['an escape sequence', 'keep names\u001b[2K'],
    ['a carriage return', 'keep names\rhide it'],
    ['a null', 'keep\u0000names'],
    ['a delete', 'keep\u007fnames'],
    ['a C1 control', 'keep\u0085names'],
    ['a vertical tab', 'keep\u000bnames'],
  ])('guards a text that hides itself on a terminal: refuses %s and stores nothing', (_label, text) => {
    const { store } = open();
    expect(() => store.guidelines.adopt({ text, parent: null, report: WINNER })).toThrow(GuidelineTextError);
    expect(store.guidelines.list()).toEqual([]);
  });

  it.each(BIDIRECTIONAL_CONTROLS)('guards a text that reorders itself on a terminal: refuses U+%s and stores nothing', (hex) => {
    const { store } = open();
    const text = `keep${String.fromCodePoint(Number.parseInt(hex, 16))}names`;
    expect(() => store.guidelines.adopt({ text, parent: null, report: WINNER })).toThrow(GuidelineTextError);
    expect(store.guidelines.list()).toEqual([]);
  });

  it('accepts a newline and a tab, which a person writes on purpose', () => {
    const { store } = open();
    expect(store.guidelines.adopt({ text: 'keep names\n\tkeep paths', parent: null, report: WINNER }).text).toBe('keep names\n\tkeep paths');
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
