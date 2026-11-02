import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createFakeClock } from '@momonga/testkit';
import type { MemoryRecord, RuntimeStore } from '@momonga/store';
import { START_MS, callEvent, enqueue, harness, mustClaim, newSession, openStoreAt, rawDb } from './helpers.ts';

const startRun = (store: RuntimeStore, callIds: readonly string[], cwd = '/work/a') => {
  const session = newSession(store, cwd);
  const run = enqueue(store, session.id);
  const claim = mustClaim(store, 'w1');
  expect(store.append(claim, callIds.map(callEvent)).kind).toBe('ok');
  return { session, run };
};

const save = (store: RuntimeStore, runId: string, callId: string, text: string, scope: 'user' | 'project' = 'user', project: string | null = null, origin: 'trusted' | 'untrusted' = 'trusted'): MemoryRecord =>
  store.memories.save({ origin, scope, project, text, runId, step: 2, callId }).memory;

describe('memory store', () => {
  it('records the scope, the source run, step and tool.call event, and the creation and last-used times', () => {
    const { store } = harness();
    const { session, run } = startRun(store, ['c1']);
    const { memory, created } = store.memories.save({ origin: 'trusted', scope: 'project', project: '/work/a', text: 'tests live in test/', runId: run.id, step: 2, callId: 'c1' });
    const call = store.readRunEvents(run.id, 0, 10).find((event) => event.type === 'tool.call');
    expect(created).toBe(true);
    expect(memory).toEqual({
      id: memory.id,
      scope: 'project',
      origin: 'trusted',
      project: '/work/a',
      text: 'tests live in test/',
      source: { kind: 'tool', sessionId: session.id, runId: run.id, step: 2, callId: 'c1', seq: call?.seq },
      createdAt: START_MS,
      lastUsedAt: START_MS,
      kind: 'fact',
      state: 'active',
      duplicateOf: null,
      supersedes: [],
      supersededBy: [],
      retiredAt: null,
      contributedAt: null,
      evidence: [],
    });
    expect(store.memories.get(memory.id)).toEqual(memory);
  });

  it('saves a replayed call once and returns the existing memory', () => {
    const { store } = harness();
    const { run } = startRun(store, ['c1']);
    const first = store.memories.save({ origin: 'trusted', scope: 'user', project: null, text: 'prefers tabs', runId: run.id, step: 1, callId: 'c1' });
    const second = store.memories.save({ origin: 'trusted', scope: 'user', project: null, text: 'prefers tabs', runId: run.id, step: 1, callId: 'c1' });
    expect(second).toEqual({ memory: first.memory, created: false });
    expect(store.memories.list()).toHaveLength(1);
  });

  it('refuses a memory whose tool.call event was never recorded', () => {
    const { store } = harness();
    const { run } = startRun(store, ['c1']);
    expect(() => store.memories.save({ origin: 'trusted', scope: 'user', project: null, text: 'x', runId: run.id, step: 1, callId: 'missing' })).toThrow(/no recorded tool.call event/);
  });

  it('requires a project exactly for project memories', () => {
    const { store } = harness();
    const { run } = startRun(store, ['c1', 'c2']);
    expect(() => store.memories.save({ origin: 'trusted', scope: 'project', project: null, text: 'x', runId: run.id, step: 1, callId: 'c1' })).toThrow(RangeError);
    expect(() => store.memories.save({ origin: 'trusted', scope: 'user', project: '/work/a', text: 'x', runId: run.id, step: 1, callId: 'c2' })).toThrow(RangeError);
  });

  it('recalls user memories everywhere and project memories only for their own project, most recently used first', () => {
    const { store, clock } = harness();
    const { run } = startRun(store, ['c1', 'c2', 'c3', 'c4']);
    const older = save(store, run.id, 'c1', 'older user memory');
    clock.advance(10);
    const mine = save(store, run.id, 'c2', 'project a memory', 'project', '/work/a');
    clock.advance(10);
    save(store, run.id, 'c3', 'project b memory', 'project', '/work/b');
    clock.advance(10);
    const newest = save(store, run.id, 'c4', 'newest user memory');
    expect(store.memories.recall({ trusted: true, project: '/work/a' }).map((memory) => memory.id)).toEqual([newest.id, mine.id, older.id]);
    expect(store.memories.recall({ trusted: false }).map((memory) => memory.id)).toEqual([newest.id, older.id]);
    clock.advance(10);
    store.memories.markUsed([older.id]);
    expect(store.memories.recall({ trusted: true, project: '/work/a' }).map((memory) => memory.id)).toEqual([older.id, newest.id, mine.id]);
    expect(store.memories.get(older.id)?.lastUsedAt).toBe(START_MS + 40);
    expect(store.memories.get(older.id)?.createdAt).toBe(START_MS);
  });

  it('keeps a user memory saved in an untrusted folder out of trusted projects and shows it only where the folder is untrusted', () => {
    const { store } = harness();
    const { run } = startRun(store, ['c1', 'c2', 'c3']);
    const trustedUser = save(store, run.id, 'c1', 'trusted user note');
    const untrustedUser = save(store, run.id, 'c2', 'injected user note', 'user', null, 'untrusted');
    const project = save(store, run.id, 'c3', 'project note', 'project', '/work/a');
    expect(untrustedUser.origin).toBe('untrusted');
    expect(store.memories.recall({ trusted: true, project: '/work/a' }).map((memory) => memory.id).sort()).toEqual([project.id, trustedUser.id].sort());
    expect(store.memories.search({ trusted: true, project: '/work/a' }, ['injected'])).toEqual([]);
    expect(store.memories.recall({ trusted: false }).map((memory) => memory.id).sort()).toEqual([trustedUser.id, untrustedUser.id].sort());
    expect(store.memories.search({ trusted: false }, ['injected']).map((memory) => memory.id)).toEqual([untrustedUser.id]);
    expect(store.memories.list().map((memory) => memory.id)).toContain(untrustedUser.id);
  });

  it('searches the visible memories for every term, ignoring case', () => {
    const { store } = harness();
    const { run } = startRun(store, ['c1', 'c2', 'c3']);
    const both = save(store, run.id, 'c1', 'Deploys run through Make and need VPN');
    save(store, run.id, 'c2', 'deploys use a staging cluster');
    save(store, run.id, 'c3', 'vpn only in project b', 'project', '/work/b');
    expect(store.memories.search({ trusted: true, project: '/work/a' }, ['deploys', 'VPN']).map((memory) => memory.id)).toEqual([both.id]);
    expect(store.memories.search({ trusted: false }, ['vpn'])).toHaveLength(1);
    expect(store.memories.search({ trusted: true, project: '/work/b' }, ['vpn'])).toHaveLength(2);
  });

  it('lists by scope and by project', () => {
    const { store } = harness();
    const { run } = startRun(store, ['c1', 'c2', 'c3']);
    const user = save(store, run.id, 'c1', 'u');
    const a = save(store, run.id, 'c2', 'a', 'project', '/work/a');
    const b = save(store, run.id, 'c3', 'b', 'project', '/work/b');
    expect(store.memories.list().map((memory) => memory.id)).toEqual([user.id, a.id, b.id]);
    expect(store.memories.list({ scope: 'project' }).map((memory) => memory.id)).toEqual([a.id, b.id]);
    expect(store.memories.list({ project: '/work/b' }).map((memory) => memory.id)).toEqual([b.id]);
  });

  it('deletes a memory for good and reports whether one existed', () => {
    const { store } = harness();
    const { run } = startRun(store, ['c1']);
    const memory = save(store, run.id, 'c1', 'forget me');
    expect(store.memories.delete(memory.id)).toBe(true);
    expect(store.memories.get(memory.id)).toBeUndefined();
    expect(store.memories.recall({ trusted: false })).toEqual([]);
    expect(store.memories.delete(memory.id)).toBe(false);
  });

  it('keeps memories across store reopenings', () => {
    const { store, dbPath } = harness();
    const { run } = startRun(store, ['c1']);
    const memory = save(store, run.id, 'c1', 'durable');
    store.close();
    const reopened = openStoreAt(path.join(path.dirname(dbPath), 'runtime.db'), createFakeClock(START_MS + 1));
    expect(reopened.memories.get(memory.id)).toEqual(memory);
  });
});

describe('memory lifecycle in the store', () => {
  const setup = () => {
    const { store, dbPath } = harness();
    const { session, run } = startRun(store, ['c1', 'c2', 'c3', 'c4', 'c5', 'c6']);
    const db = rawDb(dbPath);
    return { store, db, session, run };
  };

  it('decodes the lifecycle fields of a saved memory', () => {
    const { store, run } = setup();
    const memory = save(store, run.id, 'c1', 'tests live in test/');
    expect(memory).toMatchObject({ kind: 'fact', state: 'active', duplicateOf: null, supersedes: [], retiredAt: null, contributedAt: null, evidence: [] });
    expect(memory.source.kind).toBe('tool');
  });

  it('decodes the evidence of a memory in order, of each kind', () => {
    const { store, db, run } = setup();
    const memory = save(store, run.id, 'c1', 'tests live in test/');
    const add = db.prepare(
      'INSERT INTO memory_evidence (memory_id, ordinal, kind, project, path, sha256, sha, run_id, call_id, seq, command, exit_code) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    add.run(memory.id, 2, 'check', null, null, null, null, 'r1', 'c1', 3, 'npm test', 0);
    add.run(memory.id, 0, 'file', '/work/a', 'src/a.ts', 'abc', null, null, null, null, null, null);
    add.run(memory.id, 1, 'commit', null, null, null, 'd818eb5', null, null, null, null, null);
    expect(store.memories.get(memory.id)?.evidence).toEqual([
      { kind: 'file', project: '/work/a', path: 'src/a.ts', sha256: 'abc' },
      { kind: 'commit', sha: 'd818eb5' },
      { kind: 'check', runId: 'r1', callId: 'c1', seq: 3, command: 'npm test', exitCode: 0 },
    ]);
  });

  it('decodes a reflection memory with its ordinal and no tool call', () => {
    const { store, db, session, run } = setup();
    const memory = save(store, run.id, 'c1', 'learned');
    db.prepare("UPDATE memories SET source_kind = 'reflection', source_call_id = 'reflection:2', state = 'candidate' WHERE id = ?").run(memory.id);
    expect(store.memories.get(memory.id)?.source).toEqual({ kind: 'reflection', sessionId: session.id, runId: run.id, ordinal: 2 });
    expect(store.memories.get(memory.id)?.state).toBe('candidate');
  });

  it('decodes a retired, superseding and duplicate memory', () => {
    const { store, db, run } = setup();
    const old = save(store, run.id, 'c1', 'old');
    const next = save(store, run.id, 'c2', 'next');
    db.prepare("UPDATE memories SET supersedes_json = ?, contributed_at = 9 WHERE id = ?").run(JSON.stringify([old.id]), next.id);
    db.prepare("UPDATE memories SET retired_at = 7 WHERE id = ?").run(old.id);
    db.prepare("UPDATE memories SET state = 'duplicate', duplicate_of = ? WHERE id = ?").run(next.id, old.id);
    expect(store.memories.get(next.id)).toMatchObject({ supersedes: [old.id], contributedAt: 9 });
    expect(store.memories.get(old.id)).toMatchObject({ retiredAt: 7, state: 'duplicate', duplicateOf: next.id });
  });

  it('recalls and searches only active, live, unsuperseded memories', () => {
    const { store, db, run } = setup();
    const kept = save(store, run.id, 'c1', 'topic kept');
    const candidate = save(store, run.id, 'c2', 'topic candidate');
    const archived = save(store, run.id, 'c3', 'topic archived');
    const retired = save(store, run.id, 'c4', 'topic retired');
    const superseded = save(store, run.id, 'c5', 'topic superseded');
    const successor = save(store, run.id, 'c6', 'topic successor');
    db.prepare("UPDATE memories SET state = 'candidate' WHERE id = ?").run(candidate.id);
    db.prepare("UPDATE memories SET state = 'archived' WHERE id = ?").run(archived.id);
    db.prepare('UPDATE memories SET retired_at = 5 WHERE id = ?').run(retired.id);
    db.prepare('UPDATE memories SET supersedes_json = ? WHERE id = ?').run(JSON.stringify([superseded.id]), successor.id);
    const ids = (memories: MemoryRecord[]) => memories.map((memory) => memory.id).sort();
    const expected = [kept.id, successor.id].sort();
    expect(ids(store.memories.recall({ trusted: false }))).toEqual(expected);
    expect(ids(store.memories.search({ trusted: false }, ['topic']))).toEqual(expected);
    expect(store.memories.list()).toHaveLength(6);
  });

  it('does not let a candidate supersede a live memory', () => {
    const { store, db, run } = setup();
    const live = save(store, run.id, 'c1', 'live');
    const candidate = save(store, run.id, 'c2', 'proposal');
    db.prepare("UPDATE memories SET state = 'candidate', supersedes_json = ? WHERE id = ?").run(JSON.stringify([live.id]), candidate.id);
    expect(store.memories.recall({ trusted: false }).map((memory) => memory.id)).toEqual([live.id]);
  });
});
