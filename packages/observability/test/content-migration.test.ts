import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { migrate, openDatabase, BUSY_WAIT_LIMIT_MS } from '@momonga/foundation';
import { BODY_KINDS, openTraceStore } from '@momonga/observability';
import { createFakeClock } from '@momonga/testkit';
import type { SettledBeforeCleanup } from '@momonga/testkit';
import { TRACE_STORE_MIGRATIONS } from '../src/trace-store.ts';
import { RUN_ID, SENTINEL, START_MS, makeDir, registerCleanup, bodiesOfSpan } from './helpers.ts';

const LEGACY_VERSION = 4;

const legacyStore = (): { file: string } => {
  const file = path.join(makeDir(), 'traces.db');
  const legacy = openDatabase(file, { busyTimeoutMs: BUSY_WAIT_LIMIT_MS });
  migrate(legacy, TRACE_STORE_MIGRATIONS.slice(0, LEGACY_VERSION));
  legacy.close();
  return { file };
};

const withDb = <T>(file: string, run: (db: DatabaseSync) => SettledBeforeCleanup<T>): T => {
  const db = openDatabase(file, { busyTimeoutMs: BUSY_WAIT_LIMIT_MS });
  try {
    return run(db);
  } finally {
    db.close();
  }
};

describe('trace store migration 5: content bodies', () => {
  it('names the migration and lists the six content attribute names in the bodies kind check and in the content index', () => {
    expect(TRACE_STORE_MIGRATIONS.at(-1)).toMatchObject({ version: 5, name: 'content-bodies' });
    const { file } = legacyStore();
    openTraceStore({ busyTimeoutMs: BUSY_WAIT_LIMIT_MS, path: file , clock: createFakeClock(START_MS) }).close();
    withDb(file, (db) => {
      const tableSql = String(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'bodies'").get()?.['sql']);
      const indexSql = String(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'spans_with_content'").get()?.['sql']);
      for (const kind of BODY_KINDS) {
        expect(tableSql).toContain(`'${kind}'`);
        expect(indexSql).toContain(`"${kind}"`);
      }
    });
  });

  it('replaces the four old body kinds: an old kind is refused and a content attribute name is accepted', () => {
    const { file } = legacyStore();
    openTraceStore({ busyTimeoutMs: BUSY_WAIT_LIMIT_MS, path: file , clock: createFakeClock(START_MS) }).close();
    withDb(file, (db) => {
      const insert = (kind: string) =>
        db.prepare('INSERT INTO bodies (trace_id, span_id, kind, content, created_at_ms, expires_at_ms) VALUES (?, ?, ?, ?, ?, ?)').run('t', 's', kind, 'c', 1, 2);
      expect(() => insert('input')).toThrow();
      expect(() => insert(BODY_KINDS[0])).not.toThrow();
    });
  });

  it('serves the legacy content lookup from the partial index, so an empty backlog costs no scan of the spans table', () => {
    const { file } = legacyStore();
    openTraceStore({ busyTimeoutMs: BUSY_WAIT_LIMIT_MS, path: file , clock: createFakeClock(START_MS) }).close();
    withDb(file, (db) => {
      const indexSql = String(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'spans_with_content'").get()?.['sql']);
      const predicate = indexSql.slice(indexSql.indexOf(' WHERE ') + ' WHERE '.length);
      const plan = db
        .prepare(`EXPLAIN QUERY PLAN SELECT trace_id, span_id, end_ms, attributes_json FROM spans WHERE ${predicate} ORDER BY ingest_seq LIMIT ?`)
        .all(16)
        .map((row) => String(row['detail']))
        .join('\n');
      expect(plan).toContain('spans_with_content');
      expect(plan.split('\n')).not.toContain('SCAN spans');
      expect(plan).not.toContain('TEMP B-TREE');
    });
  });

  it('moves content that earlier spans carry in a store opened at version 4, expiring from the span end', () => {
    const { file } = legacyStore();
    const endMs = START_MS - 1000;
    withDb(file, (db) => {
      const attributes = JSON.stringify({ 'momonga.run_id': RUN_ID, [BODY_KINDS[1]]: SENTINEL });
      db.prepare(
        `INSERT INTO spans (trace_id, span_id, parent_span_id, name, kind, start_ms, end_ms, status, attributes_json, events_json, run_id, ingest_seq)
         VALUES ('t', 's', NULL, 'chat gpt-x', 'CLIENT', ?, ?, 'OK', ?, '[]', ?, 1)`,
      ).run(endMs - 5, endMs, attributes, RUN_ID);
    });
    const store = openTraceStore({ busyTimeoutMs: BUSY_WAIT_LIMIT_MS, path: file , clock: createFakeClock(START_MS) });
    registerCleanup(() => store.close());
    expect(store.moveLegacyContent({ retentionMs: 5000 })).toBe(1);
    expect(bodiesOfSpan(store, 's')).toEqual([{ traceId: 't', spanId: 's', kind: BODY_KINDS[1], content: SENTINEL, createdAtMs: endMs, expiresAtMs: endMs + 5000 }]);
    expect(JSON.stringify(store.spansForRun(RUN_ID))).not.toContain(SENTINEL);
    expect(store.moveLegacyContent({ retentionMs: 5000 })).toBe(0);
  });

  it('moves one batch at a time and bounds the batch by span count', () => {
    const { file } = legacyStore();
    withDb(file, (db) => {
      for (let index = 1; index <= 40; index += 1) {
        db.prepare(
          `INSERT INTO spans (trace_id, span_id, parent_span_id, name, kind, start_ms, end_ms, status, attributes_json, events_json, run_id, ingest_seq)
           VALUES ('t', ?, NULL, 'chat', 'CLIENT', 1, 2, 'OK', ?, '[]', ?, ?)`,
        ).run(`s${index}`, JSON.stringify({ [BODY_KINDS[2]]: `body ${index}` }), RUN_ID, index);
      }
    });
    const store = openTraceStore({ busyTimeoutMs: BUSY_WAIT_LIMIT_MS, path: file , clock: createFakeClock(START_MS) });
    registerCleanup(() => store.close());
    const batches: number[] = [];
    for (let moved = store.moveLegacyContent({ retentionMs: 1 }); moved > 0; moved = store.moveLegacyContent({ retentionMs: 1 })) batches.push(moved);
    expect(batches).toEqual([16, 16, 8]);
  });
});
