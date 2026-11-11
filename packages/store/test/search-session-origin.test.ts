import { describe, expect, it } from 'vitest';
import { enqueue, harness, mustRun } from './helpers.ts';
import { indexAll, projectDir } from './search-fixture.ts';
import type { RuntimeStore } from '@momonga/store';
import { newSession } from './helpers.ts';
import { NEVER_CANCELLED } from '@momonga/testkit';

const finishInSession = async (store: RuntimeStore, sessionId: string, task: string): Promise<string> => {
  const run = await enqueue(store, sessionId, task);
  const claim = store.claim(`worker-${run.id}`);
  if (claim?.runId !== run.id) throw new Error(`expected to claim ${run.id}`);
  const finished = await store.transition(claim, ['RUNNING'], 'COMPLETED');
  if (finished.kind !== 'ok') throw new Error(`finish failed: ${finished.kind}`);
  return mustRun(store, run.id).id;
};

describe('the origin of a run in a grouped session', () => {
  it('marks the run that was made before the folder was trusted and not the session, and keeps the mark when trust changes afterwards', async () => {
    const { store, dir, clock } = harness();
    const project = projectDir(dir, 'a');
    const session = newSession(store, project);
    const before = await finishInSession(store, session.id, 'quokka before trust');
    await store.trust.setAsked(project, 'trusted', NEVER_CANCELLED);
    clock.advance(1000);
    const after = await finishInSession(store, session.id, 'quokka after trust');
    await indexAll(store);
    await store.trust.setAsked(project, 'untrusted', NEVER_CANCELLED);
    await store.trust.setAsked(project, 'trusted', NEVER_CANCELLED);
    const result = await store.search.query({ trusted: true, project }, { query: 'quokka', scope: 'project' });
    expect(result.sessions).toHaveLength(1);
    const [grouped] = result.sessions;
    expect(Object.keys(grouped ?? {}).sort()).toEqual(['project', 'runs', 'sessionId', 'span']);
    expect(Object.fromEntries((grouped?.runs ?? []).map((anchor) => [anchor.runId, anchor.origin]))).toEqual({ [before]: 'untrusted', [after]: 'trusted' });
  });
});
