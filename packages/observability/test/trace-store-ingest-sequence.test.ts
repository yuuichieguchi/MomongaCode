import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { migrate, openDatabase, BUSY_WAIT_LIMIT_MS } from '@momonga/foundation';
import { definePriceTable, openTraceStore, pageBilledCalls } from '@momonga/observability';
import type { SpanRecord } from '@momonga/observability';
import { createFakeClock } from '@momonga/testkit';
import { TRACE_STORE_MIGRATIONS } from '../src/trace-store.ts';
import { RUN_ID, START_MS, makeDir, registerCleanup } from './helpers.ts';

const TABLE = definePriceTable([{ provider: 'acme', model: 'm1', effectiveFrom: '2026-01-01', inputPerMTok: 2, outputPerMTok: 8, currency: 'USD' }]);

const chat = (spanId: string, runId: string | null, input: number, startMs = START_MS): SpanRecord => ({
  traceId: 'trace-1',
  spanId,
  parentSpanId: null,
  name: 'chat m1',
  kind: 'CLIENT',
  startMs,
  endMs: startMs + 1,
  status: 'OK',
  attributes: { 'gen_ai.operation.name': 'chat', 'gen_ai.provider.name': 'acme', 'gen_ai.request.model': 'm1', 'gen_ai.usage.input_tokens': input, 'gen_ai.usage.output_tokens': 0 },
  events: [],
  runId,
});

const openFresh = () => {
  const store = openTraceStore({ busyTimeoutMs: BUSY_WAIT_LIMIT_MS, path: path.join(makeDir(), 'traces.db'), clock: createFakeClock(START_MS) });
  registerCleanup(() => store.close());
  return store;
};

describe('the ingest sequence of the trace store', () => {
  it('gives the spans of a version 2 database ascending sequence numbers in the order they were stored, and the next span the maximum plus one', () => {
    const file = path.join(makeDir(), 'traces.db');
    const legacy = openDatabase(file, { busyTimeoutMs: BUSY_WAIT_LIMIT_MS });
    migrate(legacy, TRACE_STORE_MIGRATIONS.slice(0, 2));
    const insert = legacy.prepare(
      'INSERT INTO spans (trace_id, span_id, parent_span_id, name, kind, start_ms, end_ms, status, attributes_json, events_json, run_id) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    for (const [spanId, startMs] of [['late', START_MS + 300], ['early', START_MS + 100], ['middle', START_MS + 200]] as const) {
      const record = chat(spanId, RUN_ID, 1, startMs);
      insert.run(record.traceId, spanId, record.name, record.kind, startMs, startMs + 1, record.status, JSON.stringify(record.attributes), '[]', RUN_ID);
    }
    legacy.close();

    const store = openTraceStore({ busyTimeoutMs: BUSY_WAIT_LIMIT_MS, path: file, clock: createFakeClock(START_MS) });
    registerCleanup(() => store.close());
    expect(store.billedChatSpansAfter(RUN_ID, 0, 10).map((entry) => [entry.span.spanId, entry.seq])).toEqual([['late', 1], ['early', 2], ['middle', 3]]);

    store.writeSpans([chat('new', RUN_ID, 1, START_MS)]);
    expect(store.billedChatSpansAfter(RUN_ID, 3, 10).map((entry) => [entry.span.spanId, entry.seq])).toEqual([['new', 4]]);
  });

  it('keeps the sequence when a span arrives twice, which is stored once', () => {
    const store = openFresh();
    store.writeSpans([chat('a', RUN_ID, 1)]);
    store.writeSpans([chat('a', RUN_ID, 1), chat('b', RUN_ID, 2)]);
    expect(store.billedChatSpansAfter(RUN_ID, 0, 10).map((entry) => [entry.span.spanId, entry.seq])).toEqual([['a', 1], ['b', 2]]);
  });

  it('pages across a boundary inside one run and into the slot of the calls that belong to no run, each call once', () => {
    const store = openFresh();
    store.writeSpans([chat('a1', 'run-a', 1), chat('a2', 'run-a', 2), chat('a3', 'run-a', 3), chat('r1', null, 10), chat('r2', null, 20), chat('b1', 'run-b', 4)]);
    const seen: number[] = [];
    let cursor: { run: number; after: number } | undefined = { run: 0, after: 0 };
    let pages = 0;
    while (cursor !== undefined) {
      const page: ReturnType<typeof pageBilledCalls> = pageBilledCalls(store, ['run-a', 'run-b'], cursor, 2, true);
      seen.push(...page.calls.map((call) => call.usage.inputTokens));
      cursor = page.next;
      pages += 1;
    }
    expect(seen).toEqual([1, 2, 3, 4, 10, 20]);
    expect(pages).toBe(3);
  });
});
