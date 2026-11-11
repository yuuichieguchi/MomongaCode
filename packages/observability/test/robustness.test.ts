import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { loggingErrorHandler, setGlobalErrorHandler } from '@opentelemetry/core';
import { ExportResultCode } from '@opentelemetry/core';
import type { ExportResult } from '@opentelemetry/core';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace';
import type { SpanExporter } from '@opentelemetry/sdk-trace';
import {
  BODY_PURGE_INTERVAL_MS,
  createBodyQueue,
  createTelemetry,
  createTraceStoreExporter,
  openTraceStore,
  startAgentSpan,
  startBodyPurge,
  startChatSpan,
} from '@momonga/observability';
import type { BodyRecord, TraceStore } from '@momonga/observability';
import { createFakeClock, createFakeTimers, waitFor, afterMicrotasks } from '@momonga/testkit';
import { CONTENT, QUIET_BATCH, RUN_ID, START_MS, dumpAllRows, harness, openStore, registerCleanup, bodiesOfSpan } from './helpers.ts';
import { BUSY_WAIT_LIMIT_MS } from '@momonga/foundation';

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

const content = { retentionMs: 1000 };

const INPUT = CONTENT.ATTR_GEN_AI_INPUT_MESSAGES;
const OUTPUT = CONTENT.ATTR_GEN_AI_OUTPUT_MESSAGES;
const TOOL_RESULT = CONTENT.ATTR_GEN_AI_TOOL_CALL_RESULT;
const SYSTEM = CONTENT.ATTR_GEN_AI_SYSTEM_INSTRUCTIONS;

const endedChat = (tracer: Parameters<typeof startChatSpan>[0], clock: { now(): number }, attributes: Record<string, string>) => {
  const chat = chatSpan(tracer);
  for (const [key, value] of Object.entries(attributes)) chat.setAttribute(key, value);
  chat.end(clock.now());
  return chat;
};

const bodyContents = (store: TraceStore, chat: { spanContext(): { spanId: string } }): string[] =>
  bodiesOfSpan(store, chat.spanContext().spanId).map((body) => body.content);

const countRows = (file: string, table: string): number => {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  } finally {
    db.close();
  }
};

const telemetryWith = (clock: ReturnType<typeof createFakeClock>, store: TraceStore, contentQueue: { maxQueuedBodies?: number; maxQueuedBytes?: number }) => {
  const telemetry = createTelemetry({
    serviceName: 's',
    serviceVersion: '1',
    clock,
    store,
    batch: QUIET_BATCH,
    captureMessageContent: true,
    contentRetentionMs: content.retentionMs,
    contentQueue,
  });
  registerCleanup(() => telemetry.shutdown());
  return telemetry;
};

describe('captured content is queued off the span path and never throws', () => {
  it('performs no store write until a flush', async () => {
    const h = harness({ content });
    const chat = endedChat(h.telemetry.tracer, h.clock, { [INPUT]: 'queued' });
    expect(bodyContents(h.store, chat)).toEqual([]);
    expect(countRows(h.file, 'bodies')).toBe(0);
    await h.telemetry.forceFlush();
    expect(bodyContents(h.store, chat)).toEqual(['queued']);
  });

  it('does not throw on a closed store and reports the persistence failure to the global error handler', async () => {
    const errors = captureErrors();
    const h = harness({ content });
    const chat = chatSpan(h.telemetry.tracer);
    h.store.close();
    expect(() => {
      chat.setAttribute(INPUT, 'x');
      chat.end(h.clock.now());
    }).not.toThrow();
    await expect(h.telemetry.forceFlush()).resolves.toBeUndefined();
    expect(errors.length).toBeGreaterThan(0);
  });

  it('drops bodies beyond the entry limit and reports them once at the next export', async () => {
    const errors = captureErrors();
    const clock = createFakeClock(START_MS);
    const { store } = openStore(clock);
    const telemetry = telemetryWith(clock, store, { maxQueuedBodies: 2 });
    const chat = endedChat(telemetry.tracer, clock, { [INPUT]: 'a', [OUTPUT]: 'b', [TOOL_RESULT]: 'c' });
    expect(errors).toHaveLength(0);
    await telemetry.forceFlush();
    expect(errors).toHaveLength(1);
    expect(String(errors[0])).toContain('dropped 1 bodies');
    expect(bodyContents(store, chat)).toEqual(['a', 'b']);
  });

  it('drops bodies beyond the byte budget measured in UTF-8 bytes', async () => {
    const errors = captureErrors();
    const clock = createFakeClock(START_MS);
    const { store } = openStore(clock);
    const telemetry = telemetryWith(clock, store, { maxQueuedBytes: 5 });
    const chat = endedChat(telemetry.tracer, clock, { [SYSTEM]: '\u00e9\u00e9\u00e9', [INPUT]: '\u00e9\u00e9', [OUTPUT]: 'x' });
    await telemetry.forceFlush();
    expect(errors).toHaveLength(1);
    expect(bodyContents(store, chat)).toEqual(['\u00e9\u00e9', 'x']);
  });

  it('aggregates 100 overflow drops into a single report', async () => {
    const errors = captureErrors();
    const clock = createFakeClock(START_MS);
    const { store } = openStore(clock);
    const telemetry = telemetryWith(clock, store, { maxQueuedBodies: 1 });
    for (let index = 0; index < 101; index += 1) endedChat(telemetry.tracer, clock, { [INPUT]: String(index) });
    await telemetry.forceFlush();
    expect(errors).toHaveLength(1);
    expect(String(errors[0])).toContain('dropped 100 bodies since last export');
  });

  it('a queue closed at shutdown enqueues nothing and reports one aggregated error', async () => {
    const errors = captureErrors();
    const queue = createBodyQueue({ maxEntries: 10, maxBytes: 1000 });
    queue.close('telemetry is shut down');
    for (const index of [1, 2, 3]) queue.push({ traceId: 't'.repeat(32), spanId: 's'.repeat(16), kind: INPUT, content: String(index), createdAtMs: START_MS, expiresAtMs: START_MS + 1 });
    await waitFor(() => errors.length > 0, { description: 'the aggregated error of the closed queue' });
    expect(errors).toHaveLength(1);
    expect(String(errors[0])).toContain('telemetry is shut down; dropped 3 bodies');
    expect(queue.drain()).toEqual([]);
  });

  it('a span ended after shutdown stores no span and no body', async () => {
    const h = harness({ content });
    const chat = chatSpan(h.telemetry.tracer);
    await h.telemetry.shutdown();
    chat.setAttribute(INPUT, 'late');
    chat.end(h.clock.now());
    await afterMicrotasks();
    expect(h.store.spansForRun(RUN_ID)).toEqual([]);
    expect(bodiesOfSpan(h.store, chat.spanContext().spanId)).toEqual([]);
  });

  it('persists the bodies of spans that ended before shutdown even when no flush ran', async () => {
    const h = harness({ content });
    const chat = endedChat(h.telemetry.tracer, h.clock, { [OUTPUT]: 'late' });
    await h.telemetry.shutdown();
    expect(bodyContents(h.store, chat)).toEqual(['late']);
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
    const errors = captureErrors();
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
    await waitFor(() => errors.length === 1, { description: 'the failure of the shutdown to reach the error handler' });
    await afterMicrotasks();
    expect(unhandled).toEqual([]);
  });
});

describe('contentRetentionMs validation', () => {
  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects %s when message content is captured into a store', (contentRetentionMs) => {
    const clock = createFakeClock(START_MS);
    const { store } = openStore(clock);
    expect(() =>
      createTelemetry({ serviceName: 's', serviceVersion: '1', clock, store, batch: QUIET_BATCH, captureMessageContent: true, contentRetentionMs }),
    ).toThrow(RangeError);
  });

  it('requires contentRetentionMs when message content is captured into a store', () => {
    const clock = createFakeClock(START_MS);
    const { store } = openStore(clock);
    expect(() => createTelemetry({ serviceName: 's', serviceVersion: '1', clock, store, batch: QUIET_BATCH, captureMessageContent: true })).toThrow(TypeError);
  });

  it('ignores contentRetentionMs when message content is not captured', async () => {
    const clock = createFakeClock(START_MS);
    const { store } = openStore(clock);
    const telemetry = createTelemetry({ serviceName: 's', serviceVersion: '1', clock, store, batch: QUIET_BATCH, contentRetentionMs: 0 });
    await telemetry.shutdown();
  });
});

describe('body retention', () => {
  it('bodiesForSpan hides bodies whose retention has elapsed', async () => {
    const h = harness({ content });
    const chat = endedChat(h.telemetry.tracer, h.clock, { [INPUT]: 'x' });
    await h.telemetry.forceFlush();
    h.clock.advance(999);
    expect(bodiesOfSpan(h.store, chat.spanContext().spanId)).toHaveLength(1);
    h.clock.advance(1);
    expect(bodiesOfSpan(h.store, chat.spanContext().spanId)).toEqual([]);
  });

  it('an export never purges; the purge timer removes the expired bodies', async () => {
    const h = harness({ content: { retentionMs: BODY_PURGE_INTERVAL_MS + BODY_PURGE_INTERVAL_MS / 6 } });
    endedChat(h.telemetry.tracer, h.clock, { [INPUT]: 'old' });
    await h.telemetry.forceFlush();
    h.clock.advance(BODY_PURGE_INTERVAL_MS / 3);
    endedChat(h.telemetry.tracer, h.clock, { [INPUT]: 'new' });
    await h.telemetry.forceFlush();
    expect(countRows(h.file, 'bodies')).toBe(2);
    const timers = createFakeTimers(h.clock);
    const reportedErrors: unknown[] = [];
    const purge = startBodyPurge({ store: h.store, timers, report: (error) => void reportedErrors.push(error) });
    registerCleanup(() => purge.stop());
    timers.advance(BODY_PURGE_INTERVAL_MS);
    expect(countRows(h.file, 'bodies')).toBe(1);
    expect(reportedErrors).toEqual([]);
  });

  it('opening the store purges expired bodies', async () => {
    const h = harness({ content });
    endedChat(h.telemetry.tracer, h.clock, { [INPUT]: 'old' });
    await h.telemetry.shutdown();
    h.store.close();
    expect(countRows(h.file, 'bodies')).toBe(1);
    h.clock.advance(2000);
    openTraceStore({ busyTimeoutMs: BUSY_WAIT_LIMIT_MS, path: h.file, clock: h.clock }).close();
    expect(countRows(h.file, 'bodies')).toBe(0);
  });

  it('a purge removes the purged bytes from the database file and compact removes them from the WAL', async () => {
    const marker = 'WALMARKER-5f2c9d41';
    const h = harness({ content });
    endedChat(h.telemetry.tracer, h.clock, { [INPUT]: marker });
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
    const h = harness({ content });
    endedChat(h.telemetry.tracer, h.clock, { [INPUT]: 'x' });
    await h.telemetry.forceFlush();
    const reader = new DatabaseSync(h.file, { readOnly: true });
    try {
      reader.exec('BEGIN');
      reader.prepare('SELECT COUNT(*) FROM bodies').get();
      h.clock.advance(5000);
      expect(h.store.purgeBodies(h.clock.now())).toBe(1);
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
    kind: INPUT,
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

  const brokenPurge = (store: TraceStore): TraceStore =>
    new Proxy(store, {
      get: (target, key, receiver) =>
        key === 'purgeExpired' || key === 'purgeBodies'
          ? () => {
              throw new Error('database is locked');
            }
          : Reflect.get(target, key, receiver),
    });

  it('an export neither purges nor loses the batch when the purge would throw', async () => {
    const errors = captureErrors();
    const clock = createFakeClock(START_MS);
    const { store } = openStore(clock);
    const telemetry = createTelemetry({
      serviceName: 's',
      serviceVersion: '1',
      clock,
      store: brokenPurge(store),
      batch: QUIET_BATCH,
      captureMessageContent: true,
      contentRetentionMs: content.retentionMs,
    });
    registerCleanup(() => telemetry.shutdown());
    const chat = endedChat(telemetry.tracer, clock, { [INPUT]: 'kept' });
    await expect(telemetry.forceFlush()).resolves.toBeUndefined();
    expect(store.spansForRun(RUN_ID)).toHaveLength(1);
    expect(bodyContents(store, chat)).toEqual(['kept']);
    expect(errors).toEqual([]);
  });

  it('the purge timer reports a purge that throws and keeps ticking', () => {
    const clock = createFakeClock(START_MS);
    const timers = createFakeTimers(clock);
    const { store } = openStore(clock);
    const reported: unknown[] = [];
    const purge = startBodyPurge({ store: brokenPurge(store), timers, report: (error) => void reported.push(error) });
    registerCleanup(() => purge.stop());
    timers.advance(BODY_PURGE_INTERVAL_MS);
    expect(reported.map(String).join('|')).toContain('database is locked');
    expect(timers.pending()).toHaveLength(1);
    timers.advance(BODY_PURGE_INTERVAL_MS);
    expect(reported).toHaveLength(2);
  });

  it('stopping the purge timer clears the pending timer and no tick runs afterwards', () => {
    const clock = createFakeClock(START_MS);
    const timers = createFakeTimers(clock);
    const { store } = openStore(clock);
    const reported: unknown[] = [];
    const purge = startBodyPurge({ store: brokenPurge(store), timers, report: (error) => void reported.push(error) });
    purge.stop();
    expect(timers.pending()).toEqual([]);
    timers.advance(BODY_PURGE_INTERVAL_MS * 2);
    expect(reported).toEqual([]);
  });
});

describe('standalone store exporter', () => {
  const record = (): BodyRecord => ({
    traceId: 't'.repeat(32),
    spanId: 's'.repeat(16),
    kind: OUTPUT,
    content: 'last words',
    createdAtMs: START_MS,
    expiresAtMs: START_MS + 1000,
  });
  const limits = { maxEntries: 10, maxBytes: 1000 };

  it.each(['forceFlush', 'shutdown'] as const)('%s drains the remaining bodies', async (phase) => {
    const { store, file } = openStore(createFakeClock(START_MS));
    const queue = createBodyQueue(limits);
    queue.push(record());
    const exporter = createTraceStoreExporter(store, { queue, retentionMs: 1000 });
    expect(dumpAllRows(file)).not.toContain('last words');
    await expect(exporter[phase]?.()).resolves.toBeUndefined();
    expect(dumpAllRows(file)).toContain('last words');
  });

  it('reports bodies lost to a failed drain once and resolves', async () => {
    const errors = captureErrors();
    const { store } = openStore(createFakeClock(START_MS));
    const queue = createBodyQueue(limits);
    queue.push(record());
    store.close();
    await expect(createTraceStoreExporter(store, { queue, retentionMs: 1000 }).shutdown()).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
    expect(String(errors[0])).toContain('dropped 1 captured bodies');
  });

  it('refuses a span that carries message content when it has no body capture, reports it and stores nothing of it', async () => {
    const errors = captureErrors();
    const clock = createFakeClock(START_MS);
    const { store, file } = openStore(clock);
    const memory = new InMemorySpanExporter();
    const telemetry = createTelemetry({ serviceName: 's', serviceVersion: '1', clock, exporters: [memory], batch: QUIET_BATCH });
    registerCleanup(() => telemetry.shutdown());
    endedChat(telemetry.tracer, clock, { [INPUT]: 'SECRET-without-capture' });
    await telemetry.forceFlush();
    const result = await new Promise<ExportResult>((resolve) => createTraceStoreExporter(store).export(memory.getFinishedSpans(), resolve));
    expect(result.code).toBe(ExportResultCode.SUCCESS);
    expect(errors).toHaveLength(1);
    expect(String(errors[0])).toContain(INPUT);
    expect(store.spansForRun(RUN_ID)).toEqual([]);
    expect(dumpAllRows(file)).not.toContain('SECRET-without-capture');
  });
});
