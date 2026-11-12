import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import { REAL_PROCESS_TEST_TIMEOUT_MS } from '@momonga/testkit';
import { launchRuntime, readDb, startStack } from './run-helpers.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const insertRunlessSpan = (file: string, spanId: string, endMs: number): void => {
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    db.prepare(
      `INSERT INTO spans (trace_id, span_id, parent_span_id, name, kind, start_ms, end_ms, status, attributes_json, events_json, run_id, ingest_seq)
       VALUES (?, ?, NULL, 'chat', 'CLIENT', ?, ?, 'OK', '{}', '[]', NULL, (SELECT COALESCE(MAX(ingest_seq), 0) + 1 FROM spans))`,
    ).run('t'.repeat(32), spanId, endMs, endMs);
  } finally {
    db.close();
  }
};

const spanIds = (file: string): string[] => readDb<{ span_id: string }>(file, 'SELECT span_id FROM spans ORDER BY span_id').map((row) => row.span_id);

describe('the runtime process runs the retention sweep while it serves', () => {
  it('sweeps at start: a runless span older than retention.days is deleted and a recent one is kept', async () => {
    const stack = await startStack({}, { retention: { days: 7 } });
    const first = await launchRuntime(stack.temp);
    await first.handle.close();
    const traces = stack.temp.paths.traces.runtime;
    insertRunlessSpan(traces, 'old-runless', 1);
    insertRunlessSpan(traces, 'recent-runless', Date.now());

    const second = await launchRuntime(stack.temp);
    await second.handle.close();

    expect(spanIds(traces)).toEqual(['recent-runless']);
  });
});
