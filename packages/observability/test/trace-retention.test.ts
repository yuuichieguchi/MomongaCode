import { describe, expect, it } from 'vitest';
import type { BodyRecord, SpanRecord, TraceStore } from '@momonga/observability';
import { createFakeClock } from '@momonga/testkit';
import { CONTENT, START_MS, dumpAllRows, openStore } from './helpers.ts';

const span = (spanId: string, runId: string | null, endMs: number): SpanRecord => ({
  traceId: 'a'.repeat(32),
  spanId,
  parentSpanId: null,
  name: 'chat',
  kind: 'CLIENT',
  startMs: endMs - 1,
  endMs,
  status: 'OK',
  attributes: {},
  events: [],
  runId,
});

const body = (spanId: string, content: string, createdAtMs: number): BodyRecord => ({
  traceId: 'a'.repeat(32),
  spanId,
  kind: CONTENT.ATTR_GEN_AI_INPUT_MESSAGES,
  content,
  createdAtMs,
  expiresAtMs: createdAtMs + 1,
});

const spanIds = (store: TraceStore, runId: string | null): string[] =>
  (runId === null ? store.spansWithoutRun() : store.spansForRun(runId)).map((record) => record.spanId);

describe('the trace store under retention', () => {
  it('deletes the spans and bodies of the given runs and the runless spans older than the cutoff, and nothing else', () => {
    const clock = createFakeClock(START_MS);
    const { store, file } = openStore(clock);
    store.writeSpans(
      [span('gone-run', 'run-old', START_MS), span('kept-run', 'run-new', START_MS), span('gone-runless', null, START_MS), span('kept-runless', null, START_MS + 100)],
      [body('gone-run', 'old run body', START_MS), body('kept-run', 'new run body', START_MS), body('gone-runless', 'old runless body', START_MS), body('kept-runless', 'new runless body', START_MS + 100)],
    );

    store.purgeRuns(['run-old'], START_MS + 50);

    expect(spanIds(store, 'run-old')).toEqual([]);
    expect(spanIds(store, 'run-new')).toEqual(['kept-run']);
    expect(spanIds(store, null)).toEqual(['kept-runless']);
    const rows = dumpAllRows(file);
    expect(rows).not.toContain('old run body');
    expect(rows).not.toContain('old runless body');
    expect(rows).toContain('new run body');
    expect(rows).toContain('new runless body');
  });

  it('keeps the body of a retained run readable whatever expiry was written with it', () => {
    const clock = createFakeClock(START_MS);
    const { store } = openStore(clock);
    store.writeSpans([span('kept-run', 'run-new', START_MS)], [body('kept-run', 'still here', START_MS)]);
    clock.advance(1000);
    expect(store.bodiesOfRunAfter('run-new', 0, 10).map((stored) => stored.body.content)).toEqual(['still here']);
  });
});
