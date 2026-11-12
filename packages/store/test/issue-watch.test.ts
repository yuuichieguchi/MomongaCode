import { describe, expect, it } from 'vitest';
import { START_MS, harness, openStoreAt } from './helpers.ts';

describe('the issue watch record', () => {
  it('answers true for the first start of a reference and false for the second', () => {
    const { store } = harness();
    expect(store.issueWatch.recordIssueStart('/work/p', 'owner/repo#7', 'run-1')).toBe(true);
    expect(store.issueWatch.recordIssueStart('/work/p', 'owner/repo#7', 'run-2')).toBe(false);
    expect(store.issueWatch.issueStartsOf('/work/p')).toEqual([{ project: '/work/p', reference: 'owner/repo#7', startedRunId: 'run-1', createdAt: START_MS }]);
  });

  it('keeps the row in a reopened store', () => {
    const { store, dbPath, clock } = harness();
    store.issueWatch.recordIssueStart('/work/p', 'owner/repo#7', 'run-1');
    store.close();
    const reopened = openStoreAt(dbPath, clock);
    expect(reopened.issueWatch.recordIssueStart('/work/p', 'owner/repo#7', 'run-3')).toBe(false);
    expect(reopened.issueWatch.issueStartsOf('/work/p').map((start) => start.startedRunId)).toEqual(['run-1']);
  });

  it('keeps one row per project for one reference', () => {
    const { store } = harness();
    expect(store.issueWatch.recordIssueStart('/work/a', 'owner/repo#7', 'run-a')).toBe(true);
    expect(store.issueWatch.recordIssueStart('/work/b', 'owner/repo#7', 'run-b')).toBe(true);
    expect(store.issueWatch.issueStartsOf('/work/a').map((start) => start.startedRunId)).toEqual(['run-a']);
    expect(store.issueWatch.issueStartsOf('/work/b').map((start) => start.startedRunId)).toEqual(['run-b']);
  });
});
