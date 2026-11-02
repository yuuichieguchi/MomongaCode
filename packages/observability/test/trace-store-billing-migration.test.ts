import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { migrate, openDatabase } from '@momonga/foundation';
import { buildCostReport, definePriceTable, openTraceStore } from '@momonga/observability';
import { createFakeClock } from '@momonga/testkit';
import { TRACE_STORE_MIGRATIONS } from '../src/trace-store.ts';
import { RUN_ID, START_MS, makeDir, registerCleanup } from './helpers.ts';

const insertSpan = (db: ReturnType<typeof openDatabase>, spanId: string, name: string, attributes: Record<string, unknown>): void => {
  db.prepare(
    'INSERT INTO spans (trace_id, span_id, parent_span_id, name, kind, start_ms, end_ms, status, attributes_json, events_json, run_id) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run('trace-1', spanId, name, 'CLIENT', START_MS, START_MS + 1, 'OK', JSON.stringify(attributes), '[]', RUN_ID);
};

describe('the chat-span billing migration of the trace store', () => {
  it('records earlier chat spans as metered so a cost report over history still reads, and leaves other spans alone', () => {
    const file = path.join(makeDir(), 'traces.db');
    const legacy = openDatabase(file);
    migrate(legacy, TRACE_STORE_MIGRATIONS.slice(0, 1));
    insertSpan(legacy, 'chat-1', 'chat m', {
      'gen_ai.operation.name': 'chat',
      'gen_ai.provider.name': 'acme',
      'gen_ai.request.model': 'm1',
      'gen_ai.usage.input_tokens': 1_000_000,
      'gen_ai.usage.output_tokens': 0,
    });
    insertSpan(legacy, 'tool-1', 'execute_tool Read', { 'gen_ai.operation.name': 'execute_tool' });
    legacy.close();

    const store = openTraceStore({ path: file, clock: createFakeClock(START_MS) });
    registerCleanup(() => store.close());
    const [chat, tool] = store.spansForRun(RUN_ID);
    expect(chat?.attributes['momonga.billing']).toBe('metered');
    expect(tool?.attributes).not.toHaveProperty('momonga.billing');
    const table = definePriceTable([{ provider: 'acme', model: 'm1', effectiveFrom: '2026-01-01', inputPerMTok: 2, outputPerMTok: 8, currency: 'USD' }]);
    expect(buildCostReport(store, [{ runId: RUN_ID, sessionId: 's' }], { table }).total).toMatchObject({ calls: 1, localCalls: 0, unpricedCalls: 0, amount: 2 });
  });
});
