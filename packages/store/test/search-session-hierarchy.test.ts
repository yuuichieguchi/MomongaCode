import { describe, expect, it } from 'vitest';
import type { Run, RuntimeStore } from '@momonga/store';
import type { FakeClock } from '@momonga/testkit';
import { HISTORY_SEARCH_ANCHOR_LIMIT } from '../src/search-constants.ts';
import { enqueue, harness, mustRun, newSession } from './helpers.ts';
import { indexAll, stepEvents } from './search-fixture.ts';
import type { Outcome, StepSpec } from './search-fixture.ts';

const OWN = { trusted: true, project: '/work/a' } as const;

type RunSpec = { task: string; steps?: StepSpec[]; outcome?: Exclude<Outcome, 'CANCELLED'> };

const sessionWithRuns = async (store: RuntimeStore, clock: FakeClock, specs: readonly RunSpec[]): Promise<{ sessionId: string; runs: Run[] }> => {
  const session = newSession(store, '/work/a');
  const runs: Run[] = [];
  for (const spec of specs) {
    clock.advance(1000);
    const run = enqueue(store, session.id, spec.task);
    const claim = store.claim(`worker-${run.id}`);
    if (claim?.runId !== run.id) throw new Error(`expected to claim ${run.id}`);
    const appended = store.append(claim, (spec.steps ?? []).flatMap((step, index) => stepEvents(index + 1, step)));
    if (appended.kind !== 'ok') throw new Error(`append failed: ${appended.kind}`);
    const outcome = spec.outcome ?? 'COMPLETED';
    const finished = await store.transition(claim, ['RUNNING'], outcome, outcome === 'FAILED' ? { error: { code: 'fixture', message: 'fixture failure' } } : {});
    if (finished.kind !== 'ok') throw new Error(`finish failed: ${finished.kind}`);
    runs.push(mustRun(store, run.id));
  }
  return { sessionId: session.id, runs };
};

describe('the history search hierarchy: session, run, step', () => {
  it('two runs of one session are returned under one session entry', async () => {
    const { store, clock } = harness();
    const { sessionId, runs } = await sessionWithRuns(store, clock, [{ task: 'fix the quokka parser' }, { task: 'test the quokka parser' }]);
    await indexAll(store);
    const result = store.search.query(OWN, { query: 'quokka', scope: 'project' });
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]?.sessionId).toBe(sessionId);
    expect(result.sessions[0]?.project).toBe('/work/a');
    expect(result.sessions[0]?.runs.map((anchor) => anchor.runId).sort()).toEqual(runs.map((run) => run.id).sort());
  });

  it('sessions are ordered by their best run', async () => {
    const { store, clock } = harness();
    const failing = await sessionWithRuns(store, clock, [{ task: 'wombat migration', outcome: 'FAILED' }]);
    const passing = await sessionWithRuns(store, clock, [{ task: 'unrelated work' }, { task: 'wombat migration' }]);
    clock.advance(1000);
    await indexAll(store);
    const result = store.search.query(OWN, { query: 'wombat', scope: 'project' });
    expect(result.sessions.map((session) => session.sessionId)).toEqual([passing.sessionId, failing.sessionId]);
  });

  it('the session entry carries the span of the runs shown and no total count', async () => {
    const { store, clock } = harness();
    const { runs } = await sessionWithRuns(store, clock, [{ task: 'numbat one' }, { task: 'something else' }, { task: 'numbat two' }]);
    await indexAll(store);
    const [session] = store.search.query(OWN, { query: 'numbat', scope: 'project' }).sessions;
    const shown = session?.runs ?? [];
    expect(shown.map((anchor) => anchor.runId).sort()).toEqual([runs[0]?.id, runs[2]?.id].sort());
    const times = shown.map((anchor) => anchor.at);
    expect(session?.span).toEqual({ from: Math.min(...times), to: Math.max(...times) });
    expect(Object.keys(session ?? {}).sort()).toEqual(['project', 'runs', 'sessionId', 'span']);
  });

  it('a withheld run does not change the span or reveal itself', async () => {
    const { store, clock } = harness();
    const { runs } = await sessionWithRuns(store, clock, [
      { task: 'first', steps: [{ tool: { name: 'Read', path: '/work/a/secret/key.txt', output: 'bilby inside the secret file' } }] },
      { task: 'second', steps: [{ tool: { name: 'Read', path: '/work/a/open.txt', output: 'bilby inside the open file' } }] },
    ]);
    await indexAll(store);
    const result = store.search.query(OWN, { query: 'bilby', scope: 'project', readDenied: (target) => target.startsWith('/work/a/secret/') });
    const [session] = result.sessions;
    expect(session?.runs.map((anchor) => anchor.runId)).toEqual([runs[1]?.id]);
    const at = session?.runs[0]?.at;
    expect(session?.span).toEqual({ from: at, to: at });
    expect(JSON.stringify(result.sessions)).not.toContain(runs[0]?.id ?? 'missing');
  });

  it('the anchor limit still counts runs', async () => {
    const { store, clock } = harness();
    await sessionWithRuns(
      store,
      clock,
      Array.from({ length: HISTORY_SEARCH_ANCHOR_LIMIT + 2 }, (_unused, index) => ({ task: `dingo task ${index}` })),
    );
    await indexAll(store);
    const result = store.search.query(OWN, { query: 'dingo', scope: 'project' });
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions.flatMap((session) => session.runs)).toHaveLength(HISTORY_SEARCH_ANCHOR_LIMIT);
  });
});
