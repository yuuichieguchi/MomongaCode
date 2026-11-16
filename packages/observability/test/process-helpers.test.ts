import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ExportResultCode } from '@opentelemetry/core';
import type { SpanExporter } from '@opentelemetry/sdk-trace';
import { closeTelemetry, contextOf, createTelemetry, openTraceStore, startAgentSpan, startChatSpan, traceparentOf } from '@momonga/observability';
import { createFakeClock } from '@momonga/testkit';
import { QUIET_BATCH, RUN_ID, START_MS, dumpAllRows, harness, makeDir } from './helpers.ts';
import { BUSY_WAIT_LIMIT_MS } from '@momonga/foundation';

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-01$/;

describe('traceparentOf and contextOf', () => {
  it('renders a span as a W3C traceparent carrying its ids', () => {
    const h = harness();
    const span = startAgentSpan(h.telemetry.tracer, { agentName: 'a', agentId: 'b', conversationId: 'c', runId: RUN_ID });
    const { traceId, spanId } = span.spanContext();
    expect(traceparentOf(span)).toBe(`00-${traceId}-${spanId}-01`);
    expect(traceparentOf(span)).toMatch(TRACEPARENT);
    span.end(h.clock.now());
  });

  it('parents a span started in another process on the propagated context', async () => {
    const h = harness();
    const parent = startAgentSpan(h.telemetry.tracer, { agentName: 'a', agentId: 'b', conversationId: 'c', runId: RUN_ID });
    const header = traceparentOf(parent);
    const child = startChatSpan(
      h.telemetry.tracer,
      { providerName: 'openai', billing: 'metered', requestModel: 'gpt-x', maxTokens: 16, stream: true, runId: RUN_ID, step: 1, attempt: 1 },
      await contextOf(header),
    );
    child.end(h.clock.now());
    parent.end(h.clock.now());
    await h.telemetry.forceFlush();
    const finished = h.memory.getFinishedSpans().find((span) => span.spanContext().spanId !== parent.spanContext().spanId);
    expect(finished?.spanContext().traceId).toBe(parent.spanContext().traceId);
    expect(finished?.parentSpanContext?.spanId).toBe(parent.spanContext().spanId);
    expect(finished?.parentSpanContext?.isRemote).toBe(true);
  });

  it('round-trips a literal traceparent', async () => {
    const h = harness();
    const header = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';
    const span = startAgentSpan(h.telemetry.tracer, { agentName: 'a', agentId: 'b', conversationId: 'c', runId: RUN_ID }, await contextOf(header));
    span.end(h.clock.now());
    await h.telemetry.forceFlush();
    const [finished] = h.memory.getFinishedSpans();
    expect(finished?.spanContext().traceId).toBe('0af7651916cd43dd8448eb211c80319c');
    expect(finished?.parentSpanContext?.spanId).toBe('b7ad6b7169203331');
  });

  it('yields a root context for a malformed traceparent', async () => {
    const h = harness();
    const span = startAgentSpan(h.telemetry.tracer, { agentName: 'a', agentId: 'b', conversationId: 'c', runId: RUN_ID }, await contextOf('garbage'));
    span.end(h.clock.now());
    await h.telemetry.forceFlush();
    const [finished] = h.memory.getFinishedSpans();
    expect(finished?.parentSpanContext).toBeUndefined();
  });
});

describe('startAgentSpan attempt', () => {
  it('records attempt as momonga.attempt', async () => {
    const h = harness();
    startAgentSpan(h.telemetry.tracer, { agentName: 'a', agentId: 'b', conversationId: 'c', runId: RUN_ID, step: 2, attempt: 3 }).end(h.clock.now());
    await h.telemetry.forceFlush();
    const [span] = h.memory.getFinishedSpans();
    expect(span?.attributes['momonga.attempt']).toBe(3);
    expect(span?.attributes['momonga.step']).toBe(2);
  });

  it('omits momonga.attempt when no attempt is given', async () => {
    const h = harness();
    startAgentSpan(h.telemetry.tracer, { agentName: 'a', agentId: 'b', conversationId: 'c', runId: RUN_ID }).end(h.clock.now());
    await h.telemetry.forceFlush();
    const [span] = h.memory.getFinishedSpans();
    expect(span?.attributes).not.toHaveProperty('momonga.attempt');
  });
});

describe('closeTelemetry', () => {
  it('flushes pending spans into the store, shuts telemetry down and closes the store', async () => {
    const clock = createFakeClock(START_MS);
    const file = path.join(makeDir(), 'gateway.db');
    const store = openTraceStore({ busyTimeoutMs: BUSY_WAIT_LIMIT_MS, path: file });
    const exportedRunIds: unknown[] = [];
    let exporterShutdown = false;
    const recorder: SpanExporter = {
      export: (spans, done) => {
        if (!exporterShutdown) exportedRunIds.push(...spans.map((span) => span.attributes['momonga.run_id']));
        done({ code: ExportResultCode.SUCCESS });
      },
      shutdown: async () => {
        exporterShutdown = true;
      },
    };
    const telemetry = createTelemetry({ serviceName: 'gateway', serviceVersion: '1.0.0', clock, store, exporters: [recorder], batch: QUIET_BATCH });
    startAgentSpan(telemetry.tracer, { agentName: 'a', agentId: 'b', conversationId: 'c', runId: 'run-close' }).end(clock.now());
    await closeTelemetry(telemetry, store);
    expect(dumpAllRows(file)).toContain('run-close');
    await expect((async () => store.spansForRun('run-close'))()).rejects.toThrow();
    startAgentSpan(telemetry.tracer, { agentName: 'a', agentId: 'b', conversationId: 'c', runId: 'run-after' }).end(clock.now());
    await telemetry.forceFlush();
    expect(exportedRunIds).toEqual(['run-close']);
    expect(exporterShutdown).toBe(true);
  });
});
