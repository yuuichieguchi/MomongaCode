import { describe, expect, it } from 'vitest';
import type { RunEventPayload } from '@momonga/protocol';
import { harness } from './helpers.ts';
import { FAKE_KEY, finishedRun, indexAll, openRun, projectDir, redactor } from './search-fixture.ts';

const OWN = { trusted: true, project: '/work/a' } as const;

describe('the denial callback of a search', () => {
  it('receives the project of the document it judges', async () => {
    const { store, dir } = harness();
    const [a, b] = [projectDir(dir, 'a'), projectDir(dir, 'b')];
    store.trust.set(a, 'trusted');
    store.trust.set(b, 'trusted');
    await finishedRun(store, a, 'task', [{ tool: { name: 'Read', path: '/p/a.txt', output: 'projectterm in a' } }]);
    await finishedRun(store, b, 'task', [{ tool: { name: 'Read', path: '/p/b.txt', output: 'projectterm in b' } }]);
    indexAll(store);
    const seen: Array<[string, string]> = [];
    store.search.query({ trusted: true, project: a }, { query: 'projectterm', scope: 'all', readDenied: (target, project) => (seen.push([target, project]), false) });
    const judged = [...new Set(seen.map(([target, project]) => `${target} ${project}`))].sort();
    expect(judged).toEqual([`/p/a.txt ${a}`, `/p/b.txt ${b}`]);
  });

  it('lists the projects a session can reach, so rules can be loaded for each', async () => {
    const { store, dir } = harness();
    const [a, b, c] = [projectDir(dir, 'a'), projectDir(dir, 'b'), projectDir(dir, 'c')];
    store.trust.set(a, 'trusted');
    store.trust.set(b, 'trusted');
    await finishedRun(store, a, 'one');
    await finishedRun(store, b, 'two');
    await finishedRun(store, c, 'three');
    indexAll(store);
    expect(store.search.visibleProjects({ trusted: true, project: a }, 'all').sort()).toEqual([a, b].sort());
    expect(store.search.visibleProjects({ trusted: true, project: a }, 'project')).toEqual([a]);
    expect(store.search.visibleProjects({ trusted: false, project: c }, 'all')).toEqual([c]);
  });
});

describe('a denied path in the touched paths of a run document', () => {
  const secret = '/work/a/secret/key.txt';

  it('is dropped from the document at query time, so neither the path nor a hit on it remains', async () => {
    const { store } = harness();
    await finishedRun(store, '/work/a', 'task', [{ tool: { name: 'Read', path: secret, output: 'unrelated output' } }]);
    indexAll(store);
    const denied = (target: string) => target.startsWith('/work/a/secret/');
    const plain = store.search.query(OWN, { query: 'key.txt', scope: 'project' });
    expect(plain.anchors).toHaveLength(1);
    const result = store.search.query(OWN, { query: 'key.txt', scope: 'project', readDenied: denied });
    expect(result.anchors).toEqual([]);
    expect(result.withheld).toBe(2);
  });

  it('is absent from the snippet of a run that matched through another word', async () => {
    const { store } = harness();
    await finishedRun(store, '/work/a', 'rename the widgetterm parser', [{ tool: { name: 'Read', path: secret, output: 'unrelated output' } }]);
    indexAll(store);
    const result = store.search.query(OWN, { query: 'widgetterm', scope: 'project', readDenied: (target) => target.startsWith('/work/a/secret/') });
    expect(JSON.stringify(result)).not.toContain('key.txt');
    expect(result.anchors).toHaveLength(1);
  });
});

describe('the candidate bound of an indexed query', () => {
  it('ranks within the newest matching documents and says how many it considered', async () => {
    const { store, clock } = harness();
    const old = await finishedRun(store, '/work/a', 'candidateterm candidateterm candidateterm old');
    clock.advance(1000);
    const middle = await finishedRun(store, '/work/a', 'candidateterm middle');
    clock.advance(1000);
    const newest = await finishedRun(store, '/work/a', 'candidateterm newest');
    indexAll(store);
    const bounded = store.search.query(OWN, { query: 'candidateterm', scope: 'project', candidateLimit: 2 });
    expect(bounded.anchors.map((anchor) => anchor.runId).sort()).toEqual([middle.id, newest.id].sort());
    expect(bounded.searched).toBe(2);
    const open = store.search.query(OWN, { query: 'candidateterm', scope: 'project', candidateLimit: 3 });
    expect(open.anchors.map((anchor) => anchor.runId)).toContain(old.id);
    expect(open.searched).toBeUndefined();
  });
});

describe('the budget of an indexing batch', () => {
  it('stops before a run that would exceed the character budget, but always indexes one', async () => {
    const { store } = harness();
    const big = 'x'.repeat(2000);
    const steps = [{ tool: { name: 'Read', path: '/work/a/f', output: big } }];
    await finishedRun(store, '/work/a', 'one', steps);
    await finishedRun(store, '/work/a', 'two', steps);
    await finishedRun(store, '/work/a', 'three', steps);
    expect(store.search.indexBatch({ limit: 10, redactor, maxChars: 6000 })).toEqual({ runs: 2 });
    expect(store.search.indexBatch({ limit: 10, redactor, maxChars: 10 })).toEqual({ runs: 1 });
    expect(store.search.indexBatch({ limit: 10, redactor, maxChars: 10 })).toEqual({ runs: 0 });
  });
});

describe('reading a range', () => {
  const credentialCall = (callId: string): RunEventPayload =>
    ({ type: 'tool.call', callId, providerCallId: callId, name: 'mcp__x__login', kind: 'other', title: 'login', rawInput: { password: 'abcd1234efgh5678ijkl' }, locations: [{ path: '/work/a/secret/x' }] }) as unknown as RunEventPayload;

  it('redacts a field name together with its value, in nested input too', async () => {
    const { store } = harness();
    const { run, claim, finish } = openRun(store, '/work/a', 'task');
    store.append(claim, [credentialCall('c1')]);
    await finish();
    const page = store.search.readRange(OWN, { runId: run.id, limit: 100, redactor });
    if (page.kind !== 'ok') throw new Error(page.kind);
    expect(JSON.stringify(page.events)).not.toContain('abcd1234efgh5678ijkl');
    expect(JSON.stringify(page.events)).toContain('[REDACTED]');
  });

  it('keys the call paths by the call id the page shows, even when redaction changed it', async () => {
    const { store } = harness();
    const callId = 'sk-12345678abcdefgh';
    const { run, claim, finish } = openRun(store, '/work/a', 'task');
    store.append(claim, [credentialCall(callId), { type: 'tool.completed', callId, status: 'completed', output: 'done' }]);
    await finish();
    const page = store.search.readRange(OWN, { runId: run.id, limit: 100, redactor });
    if (page.kind !== 'ok') throw new Error(page.kind);
    const shown = page.events.flatMap((event) => ('callId' in event && typeof event.callId === 'string' ? [event.callId] : []));
    expect(shown.length).toBe(2);
    expect(shown.every((id) => id in page.callPaths)).toBe(true);
    expect(JSON.stringify(page.callPaths)).not.toContain(FAKE_KEY);
  });
});
