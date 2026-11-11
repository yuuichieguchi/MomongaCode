import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { migrate, openDatabase, BUSY_WAIT_LIMIT_MS } from '@momonga/foundation';
import { openTraceStore } from '@momonga/observability';
import { createFakeClock } from '@momonga/testkit';
import { TRACE_STORE_MIGRATIONS } from '../src/trace-store.ts';
import { START_MS, makeDir, registerCleanup } from './helpers.ts';

describe('the run ingest index of the trace store', () => {
  it('is migration 4 and serves the billed chat spans of a run in ingest order', () => {
    expect(TRACE_STORE_MIGRATIONS.map((migration) => migration.version)).toEqual([1, 2, 3, 4, 5]);

    const file = path.join(makeDir(), 'traces.db');
    const legacy = openDatabase(file, { busyTimeoutMs: BUSY_WAIT_LIMIT_MS });
    migrate(legacy, TRACE_STORE_MIGRATIONS.slice(0, 3));
    legacy.close();
    openTraceStore({ busyTimeoutMs: BUSY_WAIT_LIMIT_MS, path: file, clock: createFakeClock(START_MS) }).close();

    const db = openDatabase(file, { busyTimeoutMs: BUSY_WAIT_LIMIT_MS });
    registerCleanup(() => db.close());
    const columns = db.prepare("SELECT name FROM pragma_index_info('spans_by_run_ingest') ORDER BY seqno").all();
    expect(columns.map((column) => column['name'])).toEqual(['run_id', 'ingest_seq']);
    const plan = db
      .prepare('EXPLAIN QUERY PLAN SELECT * FROM spans WHERE run_id = ? AND ingest_seq > ? ORDER BY ingest_seq LIMIT ?')
      .all('run-a', 0, 10)
      .map((row) => String(row['detail']))
      .join('\n');
    expect(plan).toContain('spans_by_run_ingest');
    expect(plan).not.toContain('TEMP B-TREE');
  });
});
