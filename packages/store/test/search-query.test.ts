import { describe, expect, it } from 'vitest';
import { HISTORY_SNIPPET_MAX_CHARS } from '@momonga/store';
import type { RuntimeStore } from '@momonga/store';
import { harness } from './helpers.ts';
import { finishedRun, indexAll, projectDir } from './search-fixture.ts';

const OWN = { trusted: true, project: '/work/a' } as const;

const output = (text: string) => [{ tool: { name: 'Read', path: '/work/a/f', output: text } }];

const search = (store: RuntimeStore, query: string, extra: { scanLimit?: number } = {}) => store.search.query(OWN, { query, scope: 'project', ...extra });

const foundRuns = (store: RuntimeStore, query: string, extra: { scanLimit?: number } = {}): string[] => search(store, query, extra).anchors.map((anchor) => anchor.runId);

describe('search terms of three characters or more', () => {
  it('finds a substring through the trigram index, case-insensitively', () => {
    const { store } = harness();
    const run = finishedRun(store, '/work/a', 'task', output('the CompactionSweeper ran'));
    indexAll(store);
    expect(foundRuns(store, 'compactionsweep')).toEqual([run.id]);
  });

  it('finds a three-character Japanese word', () => {
    const { store } = harness();
    const run = finishedRun(store, '/work/a', 'task', output('これはテストです'));
    indexAll(store);
    expect(foundRuns(store, 'テスト')).toEqual([run.id]);
  });

  it('requires every term', () => {
    const { store } = harness();
    const both = finishedRun(store, '/work/a', 'task', output('alpha and gamma'));
    finishedRun(store, '/work/a', 'task', output('alpha only'));
    indexAll(store);
    expect(foundRuns(store, 'alpha gamma')).toEqual([both.id]);
  });

  it.each(['foo*', 'body:deploy', 'NEAR(deploy', '-deploy', 'deploy"', '"deploy', '(deploy)', 'deploy AND'])('treats %s as literal text, not FTS syntax', (query) => {
    const { store } = harness();
    finishedRun(store, '/work/a', 'task', output('foolish deployment notes'));
    indexAll(store);
    expect(foundRuns(store, query)).toEqual([]);
  });

  it('finds a literal that contains a double quote and other FTS operators', () => {
    const { store } = harness();
    const run = finishedRun(store, '/work/a', 'task', output('config say"hi" body:deploy foo*bar'));
    indexAll(store);
    expect(foundRuns(store, 'say"hi"')).toEqual([run.id]);
    expect(foundRuns(store, 'body:deploy')).toEqual([run.id]);
    expect(foundRuns(store, 'foo*bar')).toEqual([run.id]);
  });
});

describe('search terms shorter than three characters', () => {
  it('finds a two-character Japanese word, which the trigram index cannot', () => {
    const { store } = harness();
    const run = finishedRun(store, '/work/a', 'task', output('この設計を見直す'));
    indexAll(store);
    expect(foundRuns(store, '設計')).toEqual([run.id]);
  });

  it('counts characters, not UTF-16 units, so two emoji are a short term', () => {
    const { store } = harness();
    const run = finishedRun(store, '/work/a', 'task', output('status 😀😀 done'));
    indexAll(store);
    expect(foundRuns(store, '😀😀')).toEqual([run.id]);
  });

  it('combines a short term with a long one', () => {
    const { store } = harness();
    const both = finishedRun(store, '/work/a', 'task', output('sweeper の設計'));
    finishedRun(store, '/work/a', 'task', output('sweeper の実装'));
    finishedRun(store, '/work/a', 'task', output('別の設計'));
    indexAll(store);
    expect(foundRuns(store, 'sweeper 設計')).toEqual([both.id]);
  });

  it('matches short ASCII terms case-insensitively, as the trigram index does', () => {
    const { store } = harness();
    const run = finishedRun(store, '/work/a', 'task', output('the DB is down'));
    indexAll(store);
    expect(foundRuns(store, 'db')).toEqual([run.id]);
  });

  it('scans newest first up to the bound, and says how many documents it searched', () => {
    const { store, clock } = harness();
    const old = finishedRun(store, '/work/a', '古い設計');
    clock.advance(1000);
    finishedRun(store, '/work/a', 'filler one');
    clock.advance(1000);
    const newest = finishedRun(store, '/work/a', '新しい設計');
    indexAll(store);
    const bounded = search(store, '設計', { scanLimit: 1 });
    expect(bounded.anchors.map((anchor) => anchor.runId)).toEqual([newest.id]);
    expect(bounded.searched).toBe(1);
    const open = search(store, '設計', { scanLimit: 1000 });
    expect(open.anchors.map((anchor) => anchor.runId).sort()).toEqual([old.id, newest.id].sort());
    expect(open.searched).toBeUndefined();
  });

  it('does not spend the bound on documents the session cannot see', () => {
    const { store, clock } = harness();
    const mine = finishedRun(store, '/work/a', '私の設計');
    clock.advance(1000);
    finishedRun(store, '/work/b', '他の設計');
    indexAll(store);
    expect(foundRuns(store, '設計', { scanLimit: 1 })).toEqual([mine.id]);
  });

  it('reports no searched count for a query that used only the index', () => {
    const { store } = harness();
    finishedRun(store, '/work/a', 'indexed words');
    indexAll(store);
    expect(search(store, 'indexed', { scanLimit: 1 }).searched).toBeUndefined();
  });
});

describe('search results', () => {
  it('anchors a run on its step hits with their ids, seq ranges and short snippets, never the body', () => {
    const { store } = harness();
    const long = `${'p'.repeat(600)} needleterm ${'q'.repeat(600)}`;
    const run = finishedRun(store, '/work/a', 'unrelated task', [{ text: 'nothing here' }, { tool: { name: 'Read', path: '/work/a/f', output: long } }]);
    indexAll(store);
    const [anchor] = search(store, 'needleterm').anchors;
    expect(anchor).toMatchObject({ runId: run.id, sessionId: run.sessionId, project: '/work/a', outcome: 'COMPLETED', origin: 'untrusted' });
    expect(anchor?.steps.map((step) => step.step)).toEqual([2]);
    const [hit] = anchor?.steps ?? [];
    expect(hit?.snippet).toContain('needleterm');
    expect(hit?.snippet.length).toBeLessThanOrEqual(HISTORY_SNIPPET_MAX_CHARS);
    expect(hit?.seqFrom).toBeGreaterThan(0);
    expect(hit?.seqTo).toBeGreaterThanOrEqual(hit?.seqFrom ?? Number.MAX_SAFE_INTEGER);
    expect(JSON.stringify(anchor)).not.toContain('p'.repeat(HISTORY_SNIPPET_MAX_CHARS));
    expect(anchor).not.toHaveProperty('body');
    expect(hit).not.toHaveProperty('body');
  });

  it('orders by BM25 first, even over a newer COMPLETED run', () => {
    const { store, clock } = harness();
    const strong = finishedRun(store, '/work/a', 'needleterm needleterm needleterm', [], 'FAILED');
    clock.advance(1000);
    const weak = finishedRun(store, '/work/a', `needleterm ${'padding words '.repeat(40)}`);
    indexAll(store);
    expect(foundRuns(store, 'needleterm')).toEqual([strong.id, weak.id]);
  });

  it('breaks a BM25 tie with COMPLETED over other outcomes, even when older', () => {
    const { store, clock } = harness();
    const completed = finishedRun(store, '/work/a', 'needleterm twin');
    clock.advance(1000);
    const cancelled = finishedRun(store, '/work/a', 'needleterm twin', [], 'CANCELLED');
    indexAll(store);
    expect(foundRuns(store, 'needleterm')).toEqual([completed.id, cancelled.id]);
  });

  it('breaks the remaining tie by recency', () => {
    const { store, clock } = harness();
    const older = finishedRun(store, '/work/a', 'needleterm twin');
    clock.advance(1000);
    const newer = finishedRun(store, '/work/a', 'needleterm twin');
    indexAll(store);
    expect(foundRuns(store, 'needleterm')).toEqual([newer.id, older.id]);
  });
});

describe('search visibility', () => {
  const seeded = () => {
    const context = harness();
    const { store, dir } = context;
    const [a, b, c] = [projectDir(dir, 'a'), projectDir(dir, 'b'), projectDir(dir, 'c')];
    const untrustedOriginInA = finishedRun(store, a, 'needleterm a before trust');
    const untrustedC = finishedRun(store, c, 'needleterm c');
    indexAll(store);
    store.trust.set(a, 'trusted');
    store.trust.set(b, 'trusted');
    const trustedA = finishedRun(store, a, 'needleterm a');
    const trustedB = finishedRun(store, b, 'needleterm b');
    indexAll(store);
    return { ...context, own: { trusted: true, project: a } as const, c, untrustedOriginInA, untrustedC, trustedA, trustedB };
  };

  it('shows a trusted session its project, marking an untrusted-origin run', () => {
    const { store, own, trustedA, untrustedOriginInA } = seeded();
    const { anchors } = store.search.query(own, { query: 'needleterm', scope: 'project' });
    expect(Object.fromEntries(anchors.map((anchor) => [anchor.runId, anchor.origin]))).toEqual({ [trustedA.id]: 'trusted', [untrustedOriginInA.id]: 'untrusted' });
  });

  it("adds other projects' trusted-origin runs with scope all, and never their untrusted ones", () => {
    const { store, own, trustedA, trustedB, untrustedOriginInA } = seeded();
    const { anchors } = store.search.query(own, { query: 'needleterm', scope: 'all' });
    expect(anchors.map((anchor) => anchor.runId).sort()).toEqual([trustedA.id, trustedB.id, untrustedOriginInA.id].sort());
  });

  it.each(['project', 'all'] as const)('limits an untrusted session to its own project with scope %s', (scope) => {
    const { store, c, untrustedC } = seeded();
    const { anchors } = store.search.query({ trusted: false, project: c }, { query: 'needleterm', scope });
    expect(anchors.map((anchor) => anchor.runId)).toEqual([untrustedC.id]);
  });

  it('applies visibility to the short-term scan as well', () => {
    const { store, clock } = harness();
    const mine = finishedRun(store, '/work/c', '設計 c');
    clock.advance(1);
    finishedRun(store, '/work/d', '設計 d');
    indexAll(store);
    const { anchors } = store.search.query({ trusted: false, project: '/work/c' }, { query: '設計', scope: 'all' });
    expect(anchors.map((anchor) => anchor.runId)).toEqual([mine.id]);
  });
});
