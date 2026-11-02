import { describe, expect, it } from 'vitest';
import { HISTORY_READ_PAGE_EVENTS } from '@momonga/store';
import { harness } from './helpers.ts';
import { finishedRun, indexAll, projectDir, redactor } from './search-fixture.ts';

const OWN = { trusted: true, project: '/work/a' } as const;

const SECRET = '/work/a/secret/key.txt';

const denySecret = (target: string): boolean => target.startsWith('/work/a/secret/');

const stepsOf = [
  { tool: { name: 'Read', path: SECRET, output: 'withheldterm inside the secret file' } },
  { tool: { name: 'Read', path: '/work/a/open.txt', output: 'withheldterm inside the open file' } },
];

describe('search hits whose path a read deny rule now covers', () => {
  it('yields no snippet and no hit for the step, and counts what it withheld', () => {
    const { store } = harness();
    const run = finishedRun(store, '/work/a', 'task', stepsOf);
    indexAll(store);
    const result = store.search.query(OWN, { query: 'withheldterm', scope: 'project', readDenied: denySecret });
    expect(result.anchors.map((anchor) => anchor.steps.map((step) => step.step))).toEqual([[2]]);
    expect(result.anchors[0]?.runId).toBe(run.id);
    expect(JSON.stringify(result)).not.toContain('inside the secret file');
    expect(result.withheld).toBe(1);
  });

  it('shows both steps and states nothing withheld when no predicate is given', () => {
    const { store } = harness();
    finishedRun(store, '/work/a', 'task', stepsOf);
    indexAll(store);
    const result = store.search.query(OWN, { query: 'withheldterm', scope: 'project' });
    expect(result.anchors[0]?.steps.map((step) => step.step).sort()).toEqual([1, 2]);
    expect(result.withheld).toBeUndefined();
  });

  it('drops a run whose only hits were withheld', () => {
    const { store } = harness();
    finishedRun(store, '/work/a', 'task', [stepsOf[0] as (typeof stepsOf)[number]]);
    indexAll(store);
    const result = store.search.query(OWN, { query: 'withheldterm', scope: 'project', readDenied: denySecret });
    expect(result.anchors).toEqual([]);
    expect(result.withheld).toBe(1);
  });

  it('applies to the short-term scan as well', () => {
    const { store } = harness();
    finishedRun(store, '/work/a', 'task', [{ tool: { name: 'Read', path: SECRET, output: '設計 inside the secret file' } }]);
    indexAll(store);
    const result = store.search.query(OWN, { query: '設計', scope: 'project', readDenied: denySecret });
    expect(result.anchors).toEqual([]);
    expect(result.withheld).toBe(1);
  });
});

describe('the origin of a run', () => {
  it('is the trust decision at run creation, whatever the decision is when the run is indexed', () => {
    const { store, dir } = harness();
    const [a, b] = [projectDir(dir, 'a'), projectDir(dir, 'b')];
    store.trust.set(a, 'trusted');
    const trustedThen = finishedRun(store, a, 'needleterm a');
    const untrustedThen = finishedRun(store, b, 'needleterm b');
    store.trust.set(a, 'untrusted');
    store.trust.set(b, 'trusted');
    indexAll(store);
    const origins = (project: string) => Object.fromEntries(store.search.query({ trusted: true, project }, { query: 'needleterm', scope: 'project' }).anchors.map((anchor) => [anchor.runId, anchor.origin]));
    expect(origins(a)).toEqual({ [trustedThen.id]: 'trusted' });
    expect(origins(b)).toEqual({ [untrustedThen.id]: 'untrusted' });
  });
});

describe('reading a range', () => {
  it('names the recorded paths of the calls in the range even when the call event lies before it', () => {
    const { store } = harness();
    const run = finishedRun(store, '/work/a', 'task', stepsOf);
    const events = store.readRunEvents(run.id, 0, 100);
    const completedSeq = events.find((event) => event.type === 'tool.completed')?.seq ?? 0;
    const page = store.search.readRange(OWN, { runId: run.id, seqFrom: completedSeq, seqTo: completedSeq, limit: 10, redactor });
    if (page.kind !== 'ok') throw new Error(page.kind);
    expect(page.events.map((event) => event.type)).toEqual(['tool.completed']);
    expect(page.callPaths).toEqual({ 'call-1': [SECRET] });
  });

  it('cuts a page at the character budget of its payloads, and always returns at least one event', () => {
    const { store } = harness();
    const run = finishedRun(store, '/work/a', 'task', [{ tool: { name: 'Read', path: '/work/a/big', output: 'z'.repeat(200_000) } }, { tool: { name: 'Read', path: '/work/a/big2', output: 'y'.repeat(200_000) } }]);
    const first = store.search.readRange(OWN, { runId: run.id, limit: HISTORY_READ_PAGE_EVENTS, redactor });
    if (first.kind !== 'ok') throw new Error(first.kind);
    expect(first.nextSeq).not.toBeNull();
    expect(first.events.length).toBeGreaterThan(0);
    const seen = new Set(first.events.map((event) => event.seq));
    let next = first.nextSeq;
    while (next !== null) {
      const page = store.search.readRange(OWN, { runId: run.id, seqFrom: next, limit: HISTORY_READ_PAGE_EVENTS, redactor });
      if (page.kind !== 'ok') throw new Error(page.kind);
      for (const event of page.events) seen.add(event.seq);
      next = page.nextSeq;
    }
    expect(seen.size).toBe(store.readRunEvents(run.id, 0, 1000).length);
  });
});
