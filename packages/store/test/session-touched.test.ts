import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { canonicalJson, migrate } from '@momonga/foundation';
import type { RunEventPayload } from '@momonga/protocol';
import type { RuntimeStore } from '@momonga/store';
import { createFakeClock } from '@momonga/testkit';
import { MIGRATIONS } from '../src/schema.ts';
import { START_MS, enqueue, harness, makeStoreDir, mustClaim, newSession, openStoreAt, rawDb } from './helpers.ts';

const CWD = '/work/a';

const toolCall = (callId: string, name: string, locations?: string[]): RunEventPayload => ({
  type: 'tool.call',
  callId,
  providerCallId: callId,
  name,
  kind: 'read',
  title: `${name} ${callId}`,
  rawInput: {},
  ...(locations === undefined ? {} : { locations: locations.map((entry) => ({ path: entry })) }),
});

const pathsOf = (store: RuntimeStore, sessionId: string): string[] => store.sessionTouched.after(sessionId, 0, 1000).map((entry) => entry.path);

const appendAll = (store: RuntimeStore, workerId: string, events: RunEventPayload[]) => {
  const claim = mustClaim(store, workerId);
  expect(store.append(claim, events).kind).toBe('ok');
  return claim;
};

describe('session_touched, the per-session record of declared locations', () => {
  it('a tool.call appends each declared location once per session', () => {
    const { store, dbPath } = harness();
    const session = newSession(store, CWD);
    enqueue(store, session.id);
    appendAll(store, 'w1', [toolCall('c1', 'Read', ['/work/a/x.ts', '/work/a/y.ts']), toolCall('c2', 'Edit', ['/work/a/x.ts', '/work/a/z.ts'])]);
    const entries = store.sessionTouched.after(session.id, 0, 1000);
    expect(entries.map((entry) => entry.path)).toEqual(['/work/a/x.ts', '/work/a/y.ts', '/work/a/z.ts']);
    const ids = rawDb(dbPath)
      .prepare("SELECT id FROM events WHERE type = 'tool.call' ORDER BY id")
      .all()
      .map((row) => Number(row['id']));
    expect(entries.map((entry) => entry.firstEventId)).toEqual([ids[0], ids[0], ids[1]]);
  });

  it('a tool that declares no location appends nothing, and a tool added later that declares one (an MCP tool in the test) contributes without any list being edited', () => {
    const { store } = harness();
    const session = newSession(store, CWD);
    enqueue(store, session.id);
    appendAll(store, 'w1', [toolCall('c1', 'Read'), toolCall('c2', 'mcp__docs__open_page', ['/work/a/docs/guide.md'])]);
    expect(pathsOf(store, session.id)).toEqual(['/work/a/docs/guide.md']);
  });

  it('newest returns the newest first-seen paths first, bounded by its limit', () => {
    const { store } = harness();
    const session = newSession(store, CWD);
    enqueue(store, session.id);
    const claim = appendAll(store, 'w1', ['a', 'b', 'c', 'd'].map((name, index) => toolCall(`c${index}`, 'Read', [`/work/a/${name}.ts`])));
    expect(store.append(claim, [toolCall('c9', 'Read', ['/work/a/a.ts'])]).kind).toBe('ok');
    expect(store.sessionTouched.newest(session.id, 2).map((entry) => entry.path)).toEqual(['/work/a/d.ts', '/work/a/c.ts']);
  });

  it('after reads only paths first seen after the watermark, in pages', () => {
    const { store } = harness();
    const session = newSession(store, CWD);
    enqueue(store, session.id);
    appendAll(store, 'w1', ['a', 'b', 'c'].map((name, index) => toolCall(`c${index}`, 'Read', [`/work/a/${name}.ts`])));
    const [first] = store.sessionTouched.after(session.id, 0, 1);
    expect(first?.path).toBe('/work/a/a.ts');
    expect(store.sessionTouched.after(session.id, first?.firstEventId ?? 0, 10).map((entry) => entry.path)).toEqual(['/work/a/b.ts', '/work/a/c.ts']);
  });

  it('the record survives a new run of the session and is kept per session', async () => {
    const { store } = harness();
    const session = newSession(store, CWD);
    const other = newSession(store, '/work/b');
    enqueue(store, session.id);
    const claim = appendAll(store, 'w1', [toolCall('c1', 'Read', ['/work/a/x.ts'])]);
    expect((await store.transition(claim, ['RUNNING'], 'COMPLETED')).kind).toBe('ok');
    enqueue(store, session.id);
    appendAll(store, 'w2', [toolCall('c2', 'Read', ['/work/a/x.ts', '/work/a/w.ts'])]);
    expect(pathsOf(store, session.id)).toEqual(['/work/a/x.ts', '/work/a/w.ts']);
    expect(pathsOf(store, other.id)).toEqual([]);
  });

  it('the record survives a compaction that replaced the call which declared the path', () => {
    const { store } = harness();
    const session = newSession(store, CWD);
    enqueue(store, session.id);
    const claim = appendAll(store, 'w1', [toolCall('c1', 'Read', ['/work/a/legacy/a.ts'])]);
    const compacted: RunEventPayload = {
      type: 'context.compacted',
      item: { type: 'message', role: 'user', content: 'summary' },
      summary: 'summary',
      replacedThroughSeq: 1,
    };
    expect(store.append(claim, [compacted]).kind).toBe('ok');
    expect(pathsOf(store, session.id)).toEqual(['/work/a/legacy/a.ts']);
  });

  it('the migration fills the record from the locations of existing tool.call events, so a session that predates it keeps its activations', () => {
    const before = MIGRATIONS.filter((migration) => migration.version < 23);
    const dbPath = path.join(makeStoreDir(), 'runtime.db');
    const db = new DatabaseSync(dbPath);
    try {
      migrate(db, before);
      db.prepare('INSERT INTO sessions (id, cwd, env_json, permission_mode, model_alias, created_at) VALUES (?, ?, ?, ?, ?, ?)').run('s1', CWD, '{}', 'default', 'fm', START_MS);
      db.prepare(
        `INSERT INTO runs (id, session_id, ordinal, status, version, lease_owner, lease_token, lease_expires_at, available_at, attempts, failed_attempts, cancel_requested, deadline_at, limits_json, usage_json, step, last_seq, pins, dead_letter, created_at)
         VALUES (?, ?, 1, 'COMPLETED', 1, NULL, 1, NULL, ?, 1, 0, 0, ?, '{}', ?, 1, 2, '{}', 0, ?)`,
      ).run('r1', 's1', START_MS, START_MS + 3_600_000, canonicalJson({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }), START_MS);
      const insertEvent = db.prepare('INSERT INTO events (run_id, session_id, seq, step, lease_token, created_at, type, payload_json) VALUES (?, ?, ?, 1, 1, ?, ?, ?)');
      [toolCall('c1', 'Read', ['/work/a/legacy/a.ts']), toolCall('c2', 'Bash', ['/work/a/scripts/build.sh', '/work/a/legacy/a.ts'])].forEach((payload, index) =>
        insertEvent.run('r1', 's1', index + 1, START_MS, payload.type, canonicalJson(payload)),
      );
    } finally {
      db.close();
    }
    fs.chmodSync(dbPath, 0o600);
    expect(before.length).toBeLessThan(MIGRATIONS.length);
    const store = openStoreAt(dbPath, createFakeClock(START_MS + 10));
    expect(pathsOf(store, 's1')).toEqual(['/work/a/legacy/a.ts', '/work/a/scripts/build.sh']);
  });
});
