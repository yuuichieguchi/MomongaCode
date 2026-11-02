import { describe, expect, it } from 'vitest';
import type { RunEventPayload } from '@momonga/protocol';
import type { HistoryVisibility, RuntimeStore } from '@momonga/store';
import { harness } from './helpers.ts';
import { FAKE_KEY, finishedRun, indexAll, openRun, projectDir, redactor } from './search-fixture.ts';

const OWN: HistoryVisibility = { trusted: true, project: '/work/a' };

const TWO_STEPS = [
  { text: 'first', tool: { name: 'Read', path: '/work/a/one', output: 'one' } },
  { text: 'second', tool: { name: 'Read', path: '/work/a/two', output: 'two' } },
];

const read = (store: RuntimeStore, visibility: HistoryVisibility, request: { runId: string; step?: number; seqFrom?: number; seqTo?: number; limit?: number }) =>
  store.search.readRange(visibility, { limit: 100, redactor, ...request });

const okPage = (page: ReturnType<typeof read>) => {
  if (page.kind !== 'ok') throw new Error(`expected a page, got ${page.kind}`);
  return page;
};

describe('reading a recorded range', () => {
  it('returns the events of one seq range, in order', () => {
    const { store } = harness();
    const run = finishedRun(store, '/work/a', 'task', TWO_STEPS);
    indexAll(store);
    const page = okPage(read(store, OWN, { runId: run.id, seqFrom: 2, seqTo: 4 }));
    expect(page.events.map((event) => event.seq)).toEqual([2, 3, 4]);
    expect(page.nextSeq).toBeNull();
  });

  it('returns the events of one step', () => {
    const { store } = harness();
    const run = finishedRun(store, '/work/a', 'task', TWO_STEPS);
    indexAll(store);
    const expected = store.readRunEvents(run.id, 0, 100).filter((event) => event.step === 1).map((event) => event.seq);
    expect(okPage(read(store, OWN, { runId: run.id, step: 1 })).events.map((event) => event.seq)).toEqual(expected);
  });

  it('pages by the next seq until the range is exhausted', () => {
    const { store } = harness();
    const run = finishedRun(store, '/work/a', 'task', TWO_STEPS);
    indexAll(store);
    const first = okPage(read(store, OWN, { runId: run.id, seqFrom: 1, seqTo: 5, limit: 2 }));
    expect(first.events.map((event) => event.seq)).toEqual([1, 2]);
    expect(first.nextSeq).toBe(3);
    const second = okPage(read(store, OWN, { runId: run.id, seqFrom: 3, seqTo: 5, limit: 3 }));
    expect(second.events.map((event) => event.seq)).toEqual([3, 4, 5]);
    expect(second.nextSeq).toBeNull();
  });

  it('redacts every recorded string, however deeply nested', () => {
    const { store } = harness();
    const { run, claim, finish } = openRun(store, '/work/a', `task ${FAKE_KEY}`);
    const events: RunEventPayload[] = [
      { type: 'tool.call', callId: 'c1', providerCallId: 'c1', name: 'Bash', kind: 'execute', title: `run ${FAKE_KEY}`, rawInput: { nested: { command: `curl -H ${FAKE_KEY}` } } },
      { type: 'tool.completed', callId: 'c1', status: 'completed', output: `out ${FAKE_KEY}` },
      { type: 'model.requested', step: 1, attempt: 1, digest: 'd', body: { input: [{ text: FAKE_KEY }] } },
    ];
    store.append(claim, events);
    finish();
    const page = okPage(read(store, OWN, { runId: run.id }));
    const text = JSON.stringify(page.events);
    expect(text).not.toContain(FAKE_KEY);
    expect(text).toContain('[REDACTED]');
  });

  it('keeps the handle of a large output, so the tool can point to it', () => {
    const { store } = harness();
    const run = finishedRun(store, '/work/a', 'task', [{ tool: { name: 'Read', path: '/work/a/big', output: 'head', handle: 'blob-handle-1' } }]);
    const completed = okPage(read(store, OWN, { runId: run.id })).events.find((event) => event.type === 'tool.completed');
    expect(completed).toMatchObject({ handle: 'blob-handle-1' });
  });

  it("reads the current run's replaced range before the run has ended or been indexed", () => {
    const { store } = harness();
    const { run, claim } = openRun(store, '/work/a', 'task', TWO_STEPS);
    const replaced = store.getRun(run.id)?.lastSeq ?? 0;
    store.append(claim, [{ type: 'context.compacted', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'summary' }] }, summary: 'summary', replacedThroughSeq: replaced } as unknown as RunEventPayload]);
    const page = okPage(read(store, OWN, { runId: run.id, seqFrom: 1, seqTo: replaced }));
    expect(page.events).toHaveLength(replaced);
    expect(JSON.stringify(page.events)).toContain('"output":"two"');
  });
});

describe('visibility on runId', () => {
  const seeded = () => {
    const context = harness();
    const { store, dir } = context;
    const [a, b] = [projectDir(dir, 'a'), projectDir(dir, 'b')];
    const untrustedOrigin = finishedRun(store, b, 'made before trust');
    indexAll(store);
    store.trust.set(a, 'trusted');
    store.trust.set(b, 'trusted');
    const trustedB = finishedRun(store, b, 'trusted run');
    indexAll(store);
    return { ...context, own: { trusted: true, project: a } as HistoryVisibility, b, untrustedOrigin, trustedB };
  };

  it("lets a trusted session read another project's trusted-origin run", () => {
    const { store, own, b, trustedB } = seeded();
    expect(okPage(read(store, own, { runId: trustedB.id }))).toMatchObject({ origin: 'trusted', project: b });
  });

  it("refuses a trusted session another project's untrusted-origin run", () => {
    const { store, own, untrustedOrigin } = seeded();
    expect(read(store, own, { runId: untrustedOrigin.id })).toEqual({ kind: 'not_visible' });
  });

  it('marks an untrusted-origin run of its own project for a trusted session', () => {
    const { store, b, untrustedOrigin } = seeded();
    expect(okPage(read(store, { trusted: true, project: b }, { runId: untrustedOrigin.id })).origin).toBe('untrusted');
  });

  it('refuses an untrusted session any other project, trusted origin included', () => {
    const { store, trustedB } = seeded();
    expect(read(store, { trusted: false, project: '/work/c' }, { runId: trustedB.id })).toEqual({ kind: 'not_visible' });
  });

  it('answers an unknown run exactly as a hidden one, so existence does not leak', () => {
    const { store, own } = seeded();
    expect(read(store, own, { runId: 'no-such-run' })).toEqual({ kind: 'not_visible' });
  });
});
