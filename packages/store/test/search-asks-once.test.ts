import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { HistoryVisibility } from '@momonga/store';
import { anchorsOf, harness, rawDb } from './helpers.ts';
import { finishedRun, indexAll, projectDir } from './search-fixture.ts';

const fixture = async (runs: number) => {
  const { store, dir, dbPath } = harness();
  const project = projectDir(dir, 'a');
  const secret = path.join(project, 'secret', 'key.txt');
  const open = path.join(project, 'open.txt');
  const made = [];
  for (let index = 0; index < runs; index += 1) {
    made.push(
      await finishedRun(store, project, `task ${index}`, [
        { tool: { name: 'Read', path: secret, output: 'hiddenterm inside the secret file' } },
        { tool: { name: 'Read', path: open, output: 'hiddenterm inside the open file' } },
      ]),
    );
  }
  await indexAll(store);
  const visibility: HistoryVisibility = { trusted: false, project };
  return { store, dbPath, project, secret, open, visibility, made };
};

describe('a history query asks for the verdict of each path once and finds its candidates once', () => {
  it('asks once for each distinct pair of a path and its project, though every run holds the same two paths', async () => {
    const { store, project, secret, open, visibility } = await fixture(4);
    const asked: string[] = [];

    await store.search.query(visibility, {
      query: 'hiddenterm',
      scope: 'project',
      readDenied: async (target, askedProject) => {
        asked.push(`${askedProject}\n${target}`);
        return target === secret;
      },
    });

    expect([...asked].sort()).toEqual([`${project}\n${open}`, `${project}\n${secret}`].sort());
  });

  it('gives the same result for a verdict that is answered later as for one answered at once', async () => {
    const { store, secret, visibility } = await fixture(3);

    const later = await store.search.query(visibility, { query: 'hiddenterm', scope: 'project', readDenied: async (target) => target === secret });
    const atOnce = await store.search.query(visibility, { query: 'hiddenterm', scope: 'project', readDenied: (target) => target === secret });

    expect(later).toEqual(atOnce);
    expect(later.withheld).toBeGreaterThan(0);
    expect(anchorsOf(later).flatMap((anchor) => anchor.steps.map((step) => step.snippet)).join('\n')).not.toContain('secret file');
    expect(anchorsOf(later)).toHaveLength(3);
  });

  it('leaves out a run whose documents were removed while a verdict was awaited', async () => {
    const { store, dbPath, secret, visibility, made } = await fixture(2);
    const removed = made[0];
    if (removed === undefined) throw new Error('the fixture made no run');
    let removedOnce = false;

    const result = await store.search.query(visibility, {
      query: 'hiddenterm',
      scope: 'project',
      readDenied: async (target) => {
        if (!removedOnce) {
          removedOnce = true;
          const db = rawDb(dbPath);
          db.prepare('DELETE FROM search_docs WHERE run_id = ?').run(removed.id);
          db.close();
        }
        return target === secret;
      },
    });

    expect(anchorsOf(result).map((anchor) => anchor.runId)).toEqual(made.slice(1).map((run) => run.id));
  });
});
