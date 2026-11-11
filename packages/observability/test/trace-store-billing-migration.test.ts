import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { migrate, openDatabase, BUSY_WAIT_LIMIT_MS } from '@momonga/foundation';
import { buildCostReport, definePriceTable, formatCostReport, openTraceStore } from '@momonga/observability';
import { createFakeClock } from '@momonga/testkit';
import { TRACE_STORE_MIGRATIONS } from '../src/trace-store.ts';
import { RUN_ID, START_MS, makeDir, registerCleanup } from './helpers.ts';

const insertSpan = (db: ReturnType<typeof openDatabase>, spanId: string, name: string, attributes: Record<string, unknown>): void => {
  db.prepare(
    'INSERT INTO spans (trace_id, span_id, parent_span_id, name, kind, start_ms, end_ms, status, attributes_json, events_json, run_id) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run('trace-1', spanId, name, 'CLIENT', START_MS, START_MS + 1, 'OK', JSON.stringify(attributes), '[]', RUN_ID);
};

describe('the chat-span billing migration of the trace store', () => {
  it('records earlier chat spans of any provider as unknown, and the cost report counts them as price not recorded without pricing them', () => {
    const file = path.join(makeDir(), 'traces.db');
    const legacy = openDatabase(file, { busyTimeoutMs: BUSY_WAIT_LIMIT_MS });
    migrate(legacy, TRACE_STORE_MIGRATIONS.slice(0, 1));
    const chatAttributes = (provider: string) => ({
      'gen_ai.operation.name': 'chat',
      'gen_ai.provider.name': provider,
      'gen_ai.request.model': 'm1',
      'gen_ai.usage.input_tokens': 1_000_000,
      'gen_ai.usage.output_tokens': 0,
    });
    insertSpan(legacy, 'chat-1', 'chat m', chatAttributes('acme'));
    insertSpan(legacy, 'chat-2', 'chat m', chatAttributes('apple'));
    insertSpan(legacy, 'tool-1', 'execute_tool Read', { 'gen_ai.operation.name': 'execute_tool' });
    legacy.close();

    const store = openTraceStore({ busyTimeoutMs: BUSY_WAIT_LIMIT_MS, path: file, clock: createFakeClock(START_MS) });
    registerCleanup(() => store.close());
    const spans = store.spansForRun(RUN_ID);
    const billingOf = (spanId: string) => spans.find((span) => span.spanId === spanId)?.attributes['momonga.billing'];
    expect(billingOf('chat-1')).toBe('unknown');
    expect(billingOf('chat-2')).toBe('unknown');
    expect(spans.find((span) => span.spanId === 'tool-1')?.attributes).not.toHaveProperty('momonga.billing');

    const table = definePriceTable([
      { provider: 'acme', model: 'm1', effectiveFrom: '2026-01-01', inputPerMTok: 2, outputPerMTok: 8, currency: 'USD' },
      { provider: 'apple', model: 'm1', effectiveFrom: '2026-01-01', inputPerMTok: 2, outputPerMTok: 8, currency: 'USD' },
    ]);
    const report = buildCostReport(store, [{ runId: RUN_ID, sessionId: 's' }], { table });
    expect(report.total).toMatchObject({ calls: 2, localCalls: 0, unpricedCalls: 0, unknownBillingCalls: 0, unpriced: {}, priceNotRecordedCalls: 2, inputTokens: 2_000_000, amount: null, priceVersions: [] });
    const formatted = formatCostReport(report);
    expect(formatted).toMatch(/total: 2 call\(s\), .* output tokens, not complete: price not recorded in 2 call\(s\)$/m);
    expect(formatted).not.toContain('0 USD');
    expect(formatted).not.toContain('ran locally');
    expect(formatted).not.toContain('no price entry');
  });
});
