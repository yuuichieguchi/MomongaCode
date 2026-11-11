import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import type { AttributeValue } from '@opentelemetry/api';
import { ExportResultCode } from '@opentelemetry/core';
import type { ExportResult } from '@opentelemetry/core';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace';
import type { ReadableSpan } from '@opentelemetry/sdk-trace';
import {
  BODY_KINDS,
  GENAI_CONTENT_SEMCONV,
  MOMONGA_ATTRIBUTES as OBSERVABILITY_ATTRIBUTES,
  createBodyQueue,
  createTelemetry,
  createTraceStoreExporter,
  startBodyPurge,
  startChatSpan,
} from '@momonga/observability';
import type { Telemetry, TraceStore } from '@momonga/observability';
import { MOMONGA_ATTRIBUTES } from '@momonga/protocol';
import { createFakeClock, createFakeTimers, PROPERTY_TIMEOUT_MS } from '@momonga/testkit';
import type { FakeClock } from '@momonga/testkit';
import { QUIET_BATCH, RUN_ID, SENTINEL, START_MS, dumpAllRows, openStore, registerCleanup, bodiesOfSpan } from './helpers.ts';

vi.setConfig({ testTimeout: PROPERTY_TIMEOUT_MS });

const CONTENT_KEYS = Object.values(GENAI_CONTENT_SEMCONV) as string[];
const RETENTION_MS = 30 * 86_400_000;
const RUN_ATTRIBUTE = 'momonga.run_id';

const contentValue = (key: string, tag: string): string => `${key} ${tag} ${SENTINEL}`;

const captureTelemetry = (
  clock: FakeClock,
  store: TraceStore,
  exporters: InMemorySpanExporter[] = [],
): Telemetry => {
  const telemetry = createTelemetry({
    serviceName: 'momonga-test',
    serviceVersion: '9.9.9',
    clock,
    store,
    exporters,
    batch: QUIET_BATCH,
    captureMessageContent: true,
    contentRetentionMs: RETENTION_MS,
  });
  registerCleanup(() => telemetry.shutdown());
  return telemetry;
};

const chatWithContent = (telemetry: Telemetry, keys: readonly string[], tag: string) => {
  const span = startChatSpan(telemetry.tracer, {
    providerName: 'openai',
    billing: 'metered',
    requestModel: 'gpt-x',
    stream: false,
    runId: RUN_ID,
    step: 1,
    attempt: 1,
  });
  for (const key of keys) span.setAttribute(key, contentValue(key, tag));
  span.end();
  return span.spanContext().spanId;
};

const attributesJsonRows = (file: string): string[] => {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return (db.prepare('SELECT attributes_json FROM spans').all() as { attributes_json: string }[]).map((row) => row.attributes_json);
  } finally {
    db.close();
  }
};

const bodyRows = (file: string): { span_id: string; kind: string; content: string; created_at_ms: number; expires_at_ms: number }[] => {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare('SELECT span_id, kind, content, created_at_ms, expires_at_ms FROM bodies ORDER BY id').all() as {
      span_id: string;
      kind: string;
      content: string;
      created_at_ms: number;
      expires_at_ms: number;
    }[];
  } finally {
    db.close();
  }
};

const seeded = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 4_294_967_296;
  };
};

describe('the trace store keeps message content only in bodies (D-8)', () => {
  it('names the body kinds after the six content attributes', () => {
    expect([...BODY_KINDS].sort()).toEqual([...CONTENT_KEYS].sort());
  });

  it('a captured request leaves attributes_json free of the six content keys and writes one body row per key', async () => {
    const clock = createFakeClock(START_MS);
    const { store, file } = openStore(clock);
    const telemetry = captureTelemetry(clock, store);
    const spanId = chatWithContent(telemetry, CONTENT_KEYS, 'one');
    await telemetry.forceFlush();

    const [span] = store.spansForRun(RUN_ID);
    expect(span?.spanId).toBe(spanId);
    for (const key of CONTENT_KEYS) expect(Object.keys(span?.attributes ?? {})).not.toContain(key);
    for (const json of attributesJsonRows(file)) expect(json).not.toContain(SENTINEL);

    const bodies = bodiesOfSpan(store, spanId);
    expect(bodies.map((body) => body.kind).sort()).toEqual([...CONTENT_KEYS].sort());
    for (const body of bodies) {
      expect(body.content).toBe(contentValue(body.kind, 'one'));
      expect(body.expiresAtMs - body.createdAtMs).toBe(RETENTION_MS);
    }
  });

  it('derives body capture from captureMessageContent alone and has no recordBody', () => {
    const clock = createFakeClock(START_MS);
    const { store } = openStore(clock);
    const telemetry = captureTelemetry(clock, store);
    expect(telemetry.captureMessageContent).toBe(true);
    expect('recordBody' in telemetry).toBe(false);
  });

  it('the OTLP exporter still receives the content attributes while the store moves them to bodies', async () => {
    const clock = createFakeClock(START_MS);
    const { store } = openStore(clock);
    const otlp = new InMemorySpanExporter();
    const telemetry = captureTelemetry(clock, store, [otlp]);
    const spanId = chatWithContent(telemetry, CONTENT_KEYS, 'otlp');
    await telemetry.forceFlush();
    const [exported] = otlp.getFinishedSpans();
    for (const key of CONTENT_KEYS) expect(exported?.attributes[key]).toBe(contentValue(key, 'otlp'));
    expect(bodiesOfSpan(store, spanId)).toHaveLength(CONTENT_KEYS.length);
  });

  it('the store exporter does not mutate the span it is given, so a later exporter sees the content', async () => {
    const clock = createFakeClock(START_MS);
    const { store } = openStore(clock);
    const attributes: Record<string, AttributeValue> = { [RUN_ATTRIBUTE]: RUN_ID, 'gen_ai.operation.name': 'chat' };
    for (const key of CONTENT_KEYS) attributes[key] = contentValue(key, 'direct');
    const span = {
      name: 'chat gpt-x',
      kind: SpanKind.CLIENT,
      spanContext: () => ({ traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), traceFlags: 1 }),
      parentSpanContext: undefined,
      startTime: [1_800_000_000, 0],
      endTime: [1_800_000_001, 0],
      status: { code: SpanStatusCode.OK },
      attributes,
      events: [],
    } as unknown as ReadableSpan;
    const exporter = createTraceStoreExporter(store, {
      queue: createBodyQueue({ maxEntries: 64, maxBytes: 1_000_000 }),
      retentionMs: RETENTION_MS,
    });
    const result = await new Promise<ExportResult>((resolve) => exporter.export([span], resolve));
    expect(result.code).toBe(ExportResultCode.SUCCESS);
    for (const key of CONTENT_KEYS) expect(span.attributes[key]).toBe(contentValue(key, 'direct'));
    expect(bodiesOfSpan(store, 'b'.repeat(16)).map((body) => body.kind).sort()).toEqual([...CONTENT_KEYS].sort());
    const [stored] = store.spansForRun(RUN_ID);
    for (const key of CONTENT_KEYS) expect(Object.keys(stored?.attributes ?? {})).not.toContain(key);
  });

  it('P10: after any generated export sequence no attributes_json holds a content key and every body lives exactly the retention', async () => {
    for (const seed of [1, 7, 42, 1009]) {
      const random = seeded(seed);
      const clock = createFakeClock(START_MS);
      const { store, file } = openStore(clock);
      const telemetry = captureTelemetry(clock, store);
      let expectedBodies = 0;
      const spans = 3 + Math.floor(random() * 6);
      for (let index = 0; index < spans; index += 1) {
        const keys = CONTENT_KEYS.filter(() => random() < 0.5);
        expectedBodies += keys.length;
        chatWithContent(telemetry, keys, `s${seed}-${index}`);
        clock.advance(1 + Math.floor(random() * 1000));
        if (random() < 0.4) await telemetry.forceFlush();
      }
      await telemetry.forceFlush();
      for (const json of attributesJsonRows(file)) {
        const keys = Object.keys(JSON.parse(json) as Record<string, unknown>);
        expect(keys.filter((key) => CONTENT_KEYS.includes(key)), `seed ${seed}`).toEqual([]);
      }
      const bodies = bodyRows(file);
      expect(bodies, `seed ${seed}`).toHaveLength(expectedBodies);
      for (const body of bodies) expect(body.expires_at_ms - body.created_at_ms, `seed ${seed}`).toBe(RETENTION_MS);
      clock.advance(RETENTION_MS);
      store.purgeExpired();
      expect(bodyRows(file), `seed ${seed}`).toEqual([]);
    }
  });
});

describe('legacy spans that carry content (migration of D-8)', () => {
  const insertLegacySpan = (file: string, spanId: string, endMs: number, attributes: Record<string, string>): void => {
    const db = new DatabaseSync(file);
    try {
      const next = (db.prepare('SELECT COALESCE(MAX(ingest_seq), 0) + 1 AS n FROM spans').get() as { n: number }).n;
      db.prepare(
        `INSERT INTO spans (trace_id, span_id, parent_span_id, name, kind, start_ms, end_ms, status, attributes_json, events_json, run_id, ingest_seq)
         VALUES (?, ?, NULL, 'chat gpt-x', 'CLIENT', ?, ?, 'OK', ?, '[]', ?, ?)`,
      ).run('c'.repeat(32), spanId, endMs - 10, endMs, JSON.stringify(attributes), RUN_ID, next);
    } finally {
      db.close();
    }
  };

  it('a legacy span is moved, not dropped: its content lands in bodies expiring from the span end, and attributes_json loses it', () => {
    const clock = createFakeClock(START_MS);
    const { store, file } = openStore(clock);
    const legacy: Record<string, string> = { [RUN_ATTRIBUTE]: RUN_ID, 'gen_ai.operation.name': 'chat' };
    for (const key of CONTENT_KEYS) legacy[key] = contentValue(key, 'legacy');
    const endMs = START_MS - 5_000;
    insertLegacySpan(file, 'd'.repeat(16), endMs, legacy);
    insertLegacySpan(file, 'e'.repeat(16), endMs + 1, { [RUN_ATTRIBUTE]: RUN_ID, [CONTENT_KEYS[0] as string]: contentValue(CONTENT_KEYS[0] as string, 'second') });

    let moved = 0;
    for (let batch = store.moveLegacyContent({ retentionMs: RETENTION_MS }); batch > 0; batch = store.moveLegacyContent({ retentionMs: RETENTION_MS })) {
      moved += batch;
    }
    expect(moved).toBe(2);

    for (const json of attributesJsonRows(file)) {
      expect(json).not.toContain(SENTINEL);
      expect(JSON.parse(json)).toHaveProperty([RUN_ATTRIBUTE], RUN_ID);
    }
    const first = bodyRows(file).filter((row) => row.span_id === 'd'.repeat(16));
    expect(first.map((row) => row.kind).sort()).toEqual([...CONTENT_KEYS].sort());
    for (const row of first) {
      expect(row.content).toBe(contentValue(row.kind, 'legacy'));
      expect(row.expires_at_ms).toBe(endMs + RETENTION_MS);
    }
    expect(bodyRows(file).filter((row) => row.span_id === 'e'.repeat(16)).map((row) => row.content)).toEqual([
      contentValue(CONTENT_KEYS[0] as string, 'second'),
    ]);
    expect(store.moveLegacyContent({ retentionMs: RETENTION_MS })).toBe(0);
  });
});

describe('the body purge runs on a timer, independent of export', () => {
  it('purges expired bodies with no export at all, so turning capture off cannot leave old bodies behind', () => {
    const clock = createFakeClock(START_MS);
    const timers = createFakeTimers(clock);
    const { store, file } = openStore(clock);
    store.writeSpans(
      [],
      [{ traceId: 'f'.repeat(32), spanId: '1'.repeat(16), kind: CONTENT_KEYS[0] as (typeof BODY_KINDS)[number], content: 'old', createdAtMs: START_MS, expiresAtMs: START_MS + 1_000 }],
    );
    const reported: unknown[] = [];
    const purge = startBodyPurge({ store, timers, report: (error) => void reported.push(error) });
    registerCleanup(() => purge.stop());
    expect(timers.pending()).toHaveLength(1);
    expect(bodyRows(file)).toHaveLength(1);

    clock.advance(2_000);
    const due = timers.nextDueAt();
    expect(due).toBeDefined();
    timers.advance(Math.max(0, (due ?? 0) - clock.now()));
    expect(bodyRows(file)).toEqual([]);
    expect(reported).toEqual([]);
    expect(timers.pending()).toHaveLength(1);
    expect(dumpAllRows(file)).not.toContain('"old"');
  });
});

describe('span attribute names (D-9 7.2)', () => {
  it('observability re-exports the names that protocol owns', () => {
    expect(MOMONGA_ATTRIBUTES).toBeDefined();
    expect(OBSERVABILITY_ATTRIBUTES).toBe(MOMONGA_ATTRIBUTES);
  });
});
