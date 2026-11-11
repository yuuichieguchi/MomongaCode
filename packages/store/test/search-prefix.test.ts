import { describe, expect, it } from 'vitest';
import type { HistoryAnchor, HistoryQueryResult } from '../src/index.ts';
import { harness } from './helpers.ts';
import { finishedRun, redactor } from './search-fixture.ts';

const visibility = { project: '/work/a', trusted: false };

const anchorsOf = (result: HistoryQueryResult): HistoryAnchor[] => result.sessions.flatMap((session) => session.runs);

describe('a history search sees a consistent prefix of a run the indexer pages through', () => {
  it('returns the run document covering only the indexed steps between two pages, and the whole run after the last page', async () => {
    const { store } = harness();
    const run = await finishedRun(store, '/work/a', 'widget task', [
      { text: 'widget alpha', tool: { name: 'Read', path: '/work/a/one.ts', output: 'widget one' } },
      { text: 'widget beta', tool: { name: 'Read', path: '/work/a/two.ts', output: 'widget two' } },
      { text: 'widget gamma', tool: { name: 'Read', path: '/work/a/three.ts', output: 'widget three' } },
    ]);

    const indexing = store.search.indexBatch({ limit: 1, redactor, maxChars: 1 });
    const between = await store.search.query(visibility, { query: 'widget', scope: 'project' });
    await indexing;
    const after = await store.search.query(visibility, { query: 'widget', scope: 'project' });

    const [prefix] = anchorsOf(between);
    expect(prefix?.runId).toBe(run.id);
    expect(prefix?.steps.map((step) => step.step)).toEqual([1]);
    expect(prefix?.seqTo).toBe(prefix?.steps[0]?.seqTo);
    expect(prefix?.seqTo).toBeLessThan(run.lastSeq);

    const [whole] = anchorsOf(after);
    expect(whole?.steps.map((step) => step.step).sort()).toEqual([1, 2, 3]);
    expect(whole?.seqTo).toBe(run.lastSeq);
  });
});
