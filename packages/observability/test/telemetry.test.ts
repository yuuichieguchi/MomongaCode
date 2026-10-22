import { describe, expect, it } from 'vitest';
import { ROOT_CONTEXT, propagation, trace } from '@opentelemetry/api';
import type { ProxyTracerProvider } from '@opentelemetry/api';
import { ExportResultCode } from '@opentelemetry/core';
import type { ExportResult } from '@opentelemetry/core';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace';
import {
  GENAI_SEMCONV,
  createTelemetry,
  createTraceStoreExporter,
  startAgentSpan,
  startChatSpan,
} from '@momonga/observability';
import type { SpanRecord, TraceStore } from '@momonga/observability';
import { createFakeClock } from '@momonga/testkit';
import { QUIET_BATCH, RUN_ID, START_MS, harness, openStore, registerCleanup } from './helpers.ts';

const countingExporter = () => {
  const calls: ReadableSpan[][] = [];
  const exporter: SpanExporter = {
    export: (spans, done) => {
      calls.push([...spans]);
      done({ code: ExportResultCode.SUCCESS });
    },
    shutdown: async () => {},
    forceFlush: async () => {},
  };
  return { calls, exporter };
};

const throwingExporter: SpanExporter = {
  export: () => {
    throw new Error('exporter exploded');
  },
  shutdown: async () => {},
};

const failingExporter: SpanExporter = {
  export: (_spans, done) => {
    done({ code: ExportResultCode.FAILED, error: new Error('remote rejected') });
  },
  shutdown: async () => {},
};

const agent = (tracer: Parameters<typeof startAgentSpan>[0], conversationId = 'conv-1') =>
  startAgentSpan(tracer, { agentName: 'momonga', agentId: 'agent-1', conversationId, runId: RUN_ID });

describe('createTelemetry', () => {
  it('builds spans with the service resource and the pinned schema url on the instrumentation scope', async () => {
    const { telemetry, memory, clock } = harness();
    agent(telemetry.tracer).end(clock.now());
    await telemetry.forceFlush();
    const [span] = memory.getFinishedSpans();
    expect(span?.resource.attributes['service.name']).toBe('momonga-test');
    expect(span?.resource.attributes['service.version']).toBe('9.9.9');
    expect(span?.instrumentationScope.schemaUrl).toBe(GENAI_SEMCONV.schemaUrl);
  });

  it('timestamps spans with the injected clock', async () => {
    const { telemetry, memory, clock } = harness();
    const span = agent(telemetry.tracer);
    clock.advance(42);
    span.end(clock.now());
    await telemetry.forceFlush();
    const [finished] = memory.getFinishedSpans();
    expect(finished?.startTime).toEqual([1_800_000_000, 0]);
    expect(finished?.endTime).toEqual([1_800_000_000, 42_000_000]);
  });

  it('does not register a global tracer provider or propagator', async () => {
    const before = (trace.getTracerProvider() as ProxyTracerProvider).getDelegate();
    const { telemetry, clock } = harness();
    agent(telemetry.tracer).end(clock.now());
    await telemetry.forceFlush();
    expect((trace.getTracerProvider() as ProxyTracerProvider).getDelegate()).toBe(before);
    expect(trace.getTracer('probe').startSpan('probe').isRecording()).toBe(false);
    expect(propagation.fields()).toEqual([]);
  });

  it('shutdown is idempotent', async () => {
    const { telemetry } = harness();
    await telemetry.shutdown();
    await expect(telemetry.shutdown()).resolves.toBeUndefined();
  });
});

describe('propagation', () => {
  it('round-trips W3C trace context so a chat span in another process joins the trace', async () => {
    const { telemetry, memory, clock } = harness();
    const parent = agent(telemetry.tracer);
    const headers = telemetry.propagation.inject(trace.setSpan(ROOT_CONTEXT, parent));
    const traceId = parent.spanContext().traceId;
    const parentSpanId = parent.spanContext().spanId;
    expect(headers).toEqual({ traceparent: `00-${traceId}-${parentSpanId}-01` });

    const remote = telemetry.propagation.extract({ ...headers });
    const chat = startChatSpan(
      telemetry.tracer,
      { providerName: 'openai', requestModel: 'gpt-x', stream: true, runId: RUN_ID, step: 1, attempt: 1 },
      remote,
    );
    chat.end(clock.now());
    parent.end(clock.now());
    await telemetry.forceFlush();
    const finishedChat = memory.getFinishedSpans().find((span) => span.name === 'chat gpt-x');
    expect(finishedChat?.spanContext().traceId).toBe(traceId);
    expect(finishedChat?.parentSpanContext?.spanId).toBe(parentSpanId);
  });

  it('extract of headers without traceparent yields a context with no span', () => {
    const { telemetry } = harness();
    expect(trace.getSpanContext(telemetry.propagation.extract({}))).toBeUndefined();
  });
});

describe('batching', () => {
  it('ending a span does not synchronously export; forceFlush does', async () => {
    const clock = createFakeClock(START_MS);
    const { calls, exporter } = countingExporter();
    const telemetry = createTelemetry({
      serviceName: 'svc',
      serviceVersion: '1',
      clock,
      exporters: [exporter],
      batch: QUIET_BATCH,
    });
    registerCleanup(() => telemetry.shutdown());
    agent(telemetry.tracer).end(clock.now());
    agent(telemetry.tracer).end(clock.now());
    expect(calls).toHaveLength(0);
    await telemetry.forceFlush();
    expect(calls.flat()).toHaveLength(2);
  });

  it('ending a span does not synchronously write to the trace store', async () => {
    const clock = createFakeClock(START_MS);
    const { store } = openStore(clock);
    const writes: SpanRecord[][] = [];
    const spyStore: TraceStore = new Proxy(store, {
      get: (target, key, receiver) =>
        key === 'writeSpans'
          ? (records: SpanRecord[]) => {
              writes.push(records);
              target.writeSpans(records);
            }
          : Reflect.get(target, key, receiver),
    });
    const telemetry = createTelemetry({ serviceName: 'svc', serviceVersion: '1', clock, store: spyStore, batch: QUIET_BATCH });
    registerCleanup(() => telemetry.shutdown());
    agent(telemetry.tracer).end(clock.now());
    expect(writes).toHaveLength(0);
    expect(store.spansForRun(RUN_ID)).toEqual([]);
    await telemetry.forceFlush();
    expect(writes.flat()).toHaveLength(1);
    expect(store.spansForRun(RUN_ID)).toHaveLength(1);
  });
});

describe('export failure isolation', () => {
  it('a throwing exporter and a FAILED exporter never reject forceFlush and the store still receives spans', async () => {
    const { telemetry, store, clock } = harness({ exporters: [throwingExporter, failingExporter] });
    agent(telemetry.tracer).end(clock.now());
    await expect(telemetry.forceFlush()).resolves.toBeUndefined();
    expect(store.spansForRun(RUN_ID)).toHaveLength(1);
    clock.advance(1);
    agent(telemetry.tracer, 'conv-2').end(clock.now());
    await expect(telemetry.forceFlush()).resolves.toBeUndefined();
    expect(store.spansForRun(RUN_ID)).toHaveLength(2);
  });

  it('a store write that throws is swallowed; later exports persist new spans', async () => {
    const clock = createFakeClock(START_MS);
    const { store } = openStore(clock);
    let failNext = true;
    const flakyStore: TraceStore = new Proxy(store, {
      get: (target, key, receiver) =>
        key === 'writeSpans'
          ? (records: SpanRecord[]) => {
              if (failNext) {
                failNext = false;
                throw new Error('disk I/O error');
              }
              target.writeSpans(records);
            }
          : Reflect.get(target, key, receiver),
    });
    const telemetry = createTelemetry({ serviceName: 'svc', serviceVersion: '1', clock, store: flakyStore, batch: QUIET_BATCH });
    registerCleanup(() => telemetry.shutdown());
    agent(telemetry.tracer, 'lost').end(clock.now());
    await expect(telemetry.forceFlush()).resolves.toBeUndefined();
    expect(store.spansForRun(RUN_ID)).toEqual([]);
    clock.advance(1);
    const survivor = agent(telemetry.tracer, 'kept');
    expect(survivor.isRecording()).toBe(true);
    survivor.end(clock.now());
    await expect(telemetry.forceFlush()).resolves.toBeUndefined();
    const stored = store.spansForRun(RUN_ID);
    expect(stored.map((span) => span.attributes['gen_ai.conversation.id'])).toEqual(['kept']);
  });

  it('the store exporter reports FAILED via the callback when the store is closed', async () => {
    const memory = new InMemorySpanExporter();
    const clock = createFakeClock(START_MS);
    const telemetry = createTelemetry({ serviceName: 'svc', serviceVersion: '1', clock, exporters: [memory], batch: QUIET_BATCH });
    registerCleanup(() => telemetry.shutdown());
    agent(telemetry.tracer).end(clock.now());
    await telemetry.forceFlush();
    const { store } = openStore(clock);
    store.close();
    const exporter = createTraceStoreExporter(store);
    const result = await new Promise<ExportResult>((resolve) => {
      expect(() => exporter.export(memory.getFinishedSpans(), resolve)).not.toThrow();
    });
    expect(result.code).toBe(ExportResultCode.FAILED);
    await expect(exporter.forceFlush?.()).resolves.toBeUndefined();
    await expect(exporter.shutdown()).resolves.toBeUndefined();
  });

  it('the store exporter reports SUCCESS and persists when the store is open', async () => {
    const memory = new InMemorySpanExporter();
    const clock = createFakeClock(START_MS);
    const telemetry = createTelemetry({ serviceName: 'svc', serviceVersion: '1', clock, exporters: [memory], batch: QUIET_BATCH });
    registerCleanup(() => telemetry.shutdown());
    agent(telemetry.tracer).end(clock.now());
    await telemetry.forceFlush();
    const { store } = openStore(clock);
    const result = await new Promise<ExportResult>((resolve) => {
      createTraceStoreExporter(store).export(memory.getFinishedSpans(), resolve);
    });
    expect(result.code).toBe(ExportResultCode.SUCCESS);
    expect(store.spansForRun(RUN_ID)).toHaveLength(1);
  });
});
