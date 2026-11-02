import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { loggingErrorHandler, setGlobalErrorHandler } from '@opentelemetry/core';
import { ExportResultCode } from '@opentelemetry/core';
import type { ExportResult } from '@opentelemetry/core';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace';
import type { SpanExporter } from '@opentelemetry/sdk-trace';
import {
  createBodyQueue,
  createTelemetry,
  createTraceStoreExporter,
  openTraceStore,
  startAgentSpan,
  startChatSpan,
} from '@momonga/observability';
import type { BodyRecord, TraceStore } from '@momonga/observability';
import { createFakeClock } from '@momonga/testkit';
import { QUIET_BATCH, RUN_ID, START_MS, harness, openStore, registerCleanup } from './helpers.ts';

const captureErrors = (): unknown[] => {
  const errors: unknown[] = [];
  setGlobalErrorHandler((error) => {
    errors.push(error);
  });
  registerCleanup(() => setGlobalErrorHandler(loggingErrorHandler()));
  return errors;
};

const chatSpan = (tracer: Parameters<typeof startChatSpan>[0]) =>
  startChatSpan(tracer, { providerName: 'openai', billing: 'metered', requestModel: 'gpt-x', stream: false, runId: RUN_ID, step: 1, attempt: 1 });

const bodiesEnabled = { enabled: true, retentionMs: 1000 };

const countRows = (file: string, table: string): number => {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  } finally {
    db.close();
  }
};

describe('recordBody is non-blocking and non-throwing', () => {
  it('performs no store write until a flush', async () => {
    const h = harness({ bodies: bodiesEnabled });
    const chat = chatSpan(h.telemetry.tracer);
    h.telemetry.recordBody(chat, { kind: 'input', content: 'queued' });
    expect(h.store.bodiesForSpan(chat.spanContext().spanId)).toEqual([]);
    expect(countRows(h.file, 'bodies')).toBe(0);
    chat.end(h.clock.now());
    await h.telemetry.forceFlush();
    expect(h.store.bodiesForSpan(chat.spanContext().spanId).map((body) => body.content)).toEqual(['queued']);
  });

  it('does not throw on a closed store and reports the persistence failure to the global error handler', async () => {
    const errors = captureErrors();
    const h = harness({ bodies: bodiesEnabled });
    const chat = chatSpan(h.telemetry.tracer);
    h.store.close();
    expect(() => h.telemetry.recordBody(chat, { kind: 'input', content: 'x' })).not.toThrow();
    await expect(h.telemetry.forceFlush()).resolves.toBeUndefined();
    expect(errors.length).toBeGreaterThan(0);
  });

  it('drops bodies beyond the entry limit and reports them once at the next export', async () => {
    const errors = captureErrors();
    const clock = createFakeClock(START_MS);
    const { store } = openStore(clock);
    const telemetry = createTelemetry({
      serviceName: 's',
      serviceVersion: '1',
      clock,
      store,
      batch: QUIET_BATCH,
      bodies: { ...bodiesEnabled, maxQueuedBodies: 2 },
    });
    registerCleanup(() => telemetry.shutdown());
    const chat = chatSpan(telemetry.tracer);
    for (const content of ['a', 'b', 'c']) telemetry.recordBody(chat, { kind: 'input', content });
    expect(errors).toHaveLength(0);
    await telemetry.forceFlush();
    expect(errors).toHaveLength(1);
    expect(String(errors[0])).toContain('dropped 1 bodies');
    expect(store.bodiesForSpan(chat.spanContext().spanId).map((body) => body.content)).toEqual(['a', 'b']);
  });

  it('drops bodies beyond the byte budget measured in UTF-8 bytes', async () => {
    const errors = captureErrors();
    const clock = createFakeClock(START_MS);
    const { store } = openStore(clock);
    const telemetry = createTelemetry({
      serviceName: 's',
      serviceVersion: '1',
      clock,
      store,
      batch: QUIET_BATCH,
      bodies: { ...bodiesEnabled, maxQueuedBytes: 5 },
    });
    registerCleanup(() => telemetry.shutdown());
    const chat = chatSpan(telemetry.tracer);
    for (const content of ['\u00e9\u00e9\u00e9', '\u00e9\u00e9', 'x']) telemetry.recordBody(chat, { kind: 'input', content });
    await telemetry.forceFlush();
    expect(errors).toHaveLength(1);
    expect(store.bodiesForSpan(chat.spanContext().spanId).map((body) => body.content)).toEqual(['\u00e9\u00e9', 'x']);
  });

  it('aggregates 100 overflow drops into a single report', async () => {
    const errors = captureErrors();
    const clock = createFakeClock(START_MS);
    const { store } = openStore(clock);
    const telemetry = createTelemetry({
      serviceName: 's',
      serviceVersion: '1',
      clock,
      store,
      batch: QUIET_BATCH,
      bodies: { ...bodiesEnabled, maxQueuedBodies: 1 },
    });
    registerCleanup(() => telemetry.shutdown());
    const chat = chatSpan(telemetry.tracer);
    for (let index = 0; index < 101; index += 1) telemetry.recordBody(chat, { kind: 'input', content: String(index) });
    await telemetry.forceFlush();
    expect(errors).toHaveLength(1);
    expect(String(errors[0])).toContain('dropped 100 bodies since last export');
  });

  it('after shutdown recordBody enqueues nothing and reports one aggregated error', async () => {
    const errors = captureErrors();
    const h = harness({ bodies: bodiesEnabled });
    const chat = chatSpan(h.telemetry.tracer);
    await h.telemetry.shutdown();
    for (const content of ['a', 'b', 'c']) h.telemetry.recordBody(chat, { kind: 'input', content });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(errors).toHaveLength(1);
    expect(String(errors[0])).toContain('telemetry is shut down; dropped 3 bodies');
    expect(h.store.bodiesForSpan(chat.spanContext().spanId)).toEqual([]);
  });

  it('persists queued bodies at shutdown even when no span ended', async () => {
    const h = harness({ bodies: bodiesEnabled });
    const chat = chatSpan(h.telemetry.tracer);
    h.telemetry.recordBody(chat, { kind: 'output', content: 'late' });
    await h.telemetry.shutdown();
    expect(h.store.bodiesForSpan(chat.spanContext().spanId).map((body) => body.content)).toEqual(['late']);
  });
});

describe('store exporter isolates bad spans', () => {
  const finishedSpans = async () => {
    const memory = new InMemorySpanExporter();
    const clock = createFakeClock(START_MS);
    const telemetry = createTelemetry({ serviceName: 's', serviceVersion: '1', clock, exporters: [memory], batch: QUIET_BATCH });
    registerCleanup(() => telemetry.shutdown());
    startAgentSpan(telemetry.tracer, { agentName: 'a', agentId: 'b', conversationId: 'c', runId: RUN_ID }).end(clock.now());
    const bad = telemetry.tracer.startSpan('bad', { attributes: { 'momonga.run_id': 42 } });
    bad.end(clock.now());
    await telemetry.forceFlush();
    return { spans: memory.getFinishedSpans(), clock };
  };
  const exportTo = (exporter: SpanExporter, spans: Parameters<SpanExporter['export']>[0]) =>
    new Promise<ExportResult>((resolve) => exporter.export(spans, resolve));

  it('re-exporting an already stored span succeeds and keeps one row', async () => {
    const { spans, clock } = await finishedSpans();
    const { store } = openStore(clock);
    const exporter = createTraceStoreExporter(store);
    const valid = spans.filter((span) => span.name !== 'bad');
    expect((await exportTo(exporter, valid)).code).toBe(ExportResultCode.SUCCESS);
    expect((await exportTo(exporter, valid)).code).toBe(ExportResultCode.SUCCESS);
    expect(store.spansForRun(RUN_ID)).toHaveLength(1);
  });

  it('skips and reports a malformed span while the valid ones persist', async () => {
    const errors = captureErrors();
    const { spans, clock } = await finishedSpans();
    const { store } = openStore(clock);
    const result = await exportTo(createTraceStoreExporter(store), spans);
    expect(result.code).toBe(ExportResultCode.SUCCESS);
    expect(store.spansForRun(RUN_ID)).toHaveLength(1);
    expect(errors).toHaveLength(1);
  });
});

describe('flush and shutdown failure policy', () => {
  const rejecting = (phase: 'forceFlush' | 'shutdown'): SpanExporter => ({
    export: (_spans, done) =>
      done(
        phase === 'forceFlush'
          ? { code: ExportResultCode.FAILED, error: new Error('export boom') }
          : { code: ExportResultCode.SUCCESS },
      ),
    shutdown: phase === 'shutdown' ? () => Promise.reject(new Error('shutdown boom')) : async () => {},
  });

  it('forceFlush reports the failure to the global error handler and resolves', async () => {
    const errors = captureErrors();
    const h = harness({ exporters: [rejecting('forceFlush')] });
    startAgentSpan(h.telemetry.tracer, { agentName: 'a', agentId: 'b', conversationId: 'c', runId: RUN_ID }).end(h.clock.now());
    await expect(h.telemetry.forceFlush()).resolves.toBeUndefined();
    expect(errors.length).toBeGreaterThan(0);
  });

  it('shutdown reports the failure to the global error handler and resolves', async () => {
    const errors = captureErrors();
    const h = harness({ exporters: [rejecting('shutdown')] });
    await expect(h.telemetry.shutdown()).resolves.toBeUndefined();
    expect(errors.length).toBeGreaterThan(0);
  });

  it('an unawaited shutdown leaves no unhandled rejection', async () => {
    captureErrors();
    const unhandled: unknown[] = [];
    const listener = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', listener);
    registerCleanup(() => {
      process.off('unhandledRejection', listener);
    });
    const h = harness({ exporters: [rejecting('shutdown')] });
    void h.telemetry.shutdown();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(unhandled).toEqual([]);
  });
});

describe('bodies.retentionMs validation', () => {
  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects %s when bodies are enabled', (retentionMs) => {
    const clock = createFakeClock(START_MS);
    const { store } = openStore(clock);
    expect(() =>
      createTelemetry({ serviceName: 's', serviceVersion: '1', clock, store, batch: QUIET_BATCH, bodies: { enabled: true, retentionMs } }),
    ).toThrow(RangeError);
  });

  it('ignores retentionMs when bodies are disabled', async () => {
    const clock = createFakeClock(START_MS);
    const telemetry = createTelemetry({ serviceName: 's', serviceVersion: '1', clock, batch: QUIET_BATCH, bodies: { enabled: false, retentionMs: 0 } });
    await telemetry.shutdown();
  });
});

describe('body retention', () => {
  it('bodiesForSpan hides bodies whose retention has elapsed', async () => {
    const h = harness({ bodies: bodiesEnabled });
    const chat = chatSpan(h.telemetry.tracer);
    h.telemetry.recordBody(chat, { kind: 'input', content: 'x' });
    chat.end(h.clock.now());
    await h.telemetry.forceFlush();
    h.clock.advance(999);
    expect(h.store.bodiesForSpan(chat.spanContext().spanId)).toHaveLength(1);
    h.clock.advance(1);
    expect(h.store.bodiesForSpan(chat.spanContext().spanId)).toEqual([]);
  });

  it('a batch that writes bodies purges expired bodies', async () => {
    const h = harness({ bodies: bodiesEnabled });
    const first = chatSpan(h.telemetry.tracer);
    h.telemetry.recordBody(first, { kind: 'input', content: 'old' });
    first.end(h.clock.now());
    await h.telemetry.forceFlush();
    h.clock.advance(2000);
    const second = chatSpan(h.telemetry.tracer);
    h.telemetry.recordBody(second, { kind: 'input', content: 'new' });
    second.end(h.clock.now());
    await h.telemetry.forceFlush();
    expect(countRows(h.file, 'bodies')).toBe(1);
  });

  it('opening the store purges expired bodies', async () => {
    const h = harness({ bodies: bodiesEnabled });
    const chat = chatSpan(h.telemetry.tracer);
    h.telemetry.recordBody(chat, { kind: 'input', content: 'old' });
    chat.end(h.clock.now());
    await h.telemetry.shutdown();
    h.store.close();
    expect(countRows(h.file, 'bodies')).toBe(1);
    h.clock.advance(2000);
    openTraceStore({ path: h.file, clock: h.clock }).close();
    expect(countRows(h.file, 'bodies')).toBe(0);
  });

  it('a purge removes the purged bytes from the database file and compact removes them from the WAL', async () => {
    const marker = 'WALMARKER-5f2c9d41';
    const h = harness({ bodies: bodiesEnabled });
    const chat = chatSpan(h.telemetry.tracer);
    h.telemetry.recordBody(chat, { kind: 'input', content: marker });
    chat.end(h.clock.now());
    await h.telemetry.forceFlush();
    const bytes = (): string =>
      [h.file, `${h.file}-wal`].map((file) => (fs.existsSync(file) ? fs.readFileSync(file).toString('latin1') : '')).join('|');
    expect(bytes()).toContain(marker);
    h.clock.advance(5000);
    expect(h.store.purgeBodies(h.clock.now())).toBe(1);
    expect(fs.readFileSync(h.file).toString('latin1')).not.toContain(marker);
    h.store.compact();
    expect(bytes()).not.toContain(marker);
  });

  it('a purge never blocks on a concurrent reader and reports the incomplete checkpoint', async () => {
    const errors = captureErrors();
    const h = harness({ bodies: bodiesEnabled });
    const chat = chatSpan(h.telemetry.tracer);
    h.telemetry.recordBody(chat, { kind: 'input', content: 'x' });
    chat.end(h.clock.now());
    await h.telemetry.forceFlush();
    const reader = new DatabaseSync(h.file, { readOnly: true });
    try {
      reader.exec('BEGIN');
      reader.prepare('SELECT COUNT(*) FROM bodies').get();
      h.clock.advance(5000);
      const started = performance.now();
      expect(h.store.purgeBodies(h.clock.now())).toBe(1);
      expect(performance.now() - started).toBeLessThan(1000);
      expect(errors).toHaveLength(1);
      expect(String(errors[0])).toContain('checkpoint');
    } finally {
      reader.close();
    }
  });
});

describe('housekeeping is separate from the write', () => {
  const bodyRecord = (spanId: string, expiresAtMs: number): BodyRecord => ({
    traceId: 't'.repeat(32),
    spanId,
    kind: 'input',
    content: 'x',
    createdAtMs: START_MS,
    expiresAtMs,
  });

  it('writeSpans never purges', () => {
    const clock = createFakeClock(START_MS);
    const { store, file } = openStore(clock);
    store.writeSpans([], [bodyRecord('a'.repeat(16), START_MS + 1)]);
    clock.advance(10);
    store.writeSpans([], [bodyRecord('b'.repeat(16), START_MS + 1000)]);
    expect(countRows(file, 'bodies')).toBe(2);
  });

  it('a purge that throws neither loses the batch nor escapes, and is reported', async () => {
    const errors = captureErrors();
    const clock = createFakeClock(START_MS);
    const { store } = openStore(clock);
    const brokenPurge: TraceStore = new Proxy(store, {
      get: (target, key, receiver) =>
        key === 'purgeExpired' || key === 'purgeBodies'
          ? () => {
              throw new Error('database is locked');
            }
          : Reflect.get(target, key, receiver),
    });
    const telemetry = createTelemetry({ serviceName: 's', serviceVersion: '1', clock, store: brokenPurge, batch: QUIET_BATCH, bodies: bodiesEnabled });
    registerCleanup(() => telemetry.shutdown());
    const chat = chatSpan(telemetry.tracer);
    telemetry.recordBody(chat, { kind: 'input', content: 'kept' });
    chat.end(clock.now());
    await expect(telemetry.forceFlush()).resolves.toBeUndefined();
    expect(store.spansForRun(RUN_ID)).toHaveLength(1);
    expect(store.bodiesForSpan(chat.spanContext().spanId)).toHaveLength(1);
    expect(errors.map(String).join('|')).toContain('database is locked');
  });
});

describe('standalone store exporter', () => {
  const record = (): BodyRecord => ({
    traceId: 't'.repeat(32),
    spanId: 's'.repeat(16),
    kind: 'output',
    content: 'last words',
    createdAtMs: START_MS,
    expiresAtMs: START_MS + 1000,
  });
  const limits = { maxEntries: 10, maxBytes: 1000 };

  it.each(['forceFlush', 'shutdown'] as const)('%s drains the remaining bodies', async (phase) => {
    const { store } = openStore(createFakeClock(START_MS));
    const queue = createBodyQueue(limits);
    queue.push(record());
    const exporter = createTraceStoreExporter(store, queue);
    await expect(exporter[phase]?.()).resolves.toBeUndefined();
    expect(store.bodiesForSpan('s'.repeat(16)).map((body) => body.content)).toEqual(['last words']);
  });

  it('reports bodies lost to a failed drain once and resolves', async () => {
    const errors = captureErrors();
    const { store } = openStore(createFakeClock(START_MS));
    const queue = createBodyQueue(limits);
    queue.push(record());
    store.close();
    await expect(createTraceStoreExporter(store, queue).shutdown()).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
    expect(String(errors[0])).toContain('dropped 1 captured bodies');
  });
});
