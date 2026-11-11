import { describe, expect, it } from 'vitest';
import type { SpanExporter } from '@opentelemetry/sdk-trace';
import { createTelemetry, startAgentSpan } from '@momonga/observability';
import { createFakeClock } from '@momonga/testkit';
import { QUIET_BATCH, RUN_ID, START_MS, openStore, registerCleanup } from './helpers.ts';

const holdingCollector = (): { exporter: SpanExporter; exported: () => number } => {
  let exported = 0;
  const exporter: SpanExporter = {
    export: () => {
      exported += 1;
    },
    shutdown: async () => {},
    forceFlush: () => new Promise<void>(() => {}),
  };
  return { exporter, exported: () => exported };
};

describe('a local read does not wait for the remote export', () => {
  it('flushLocal writes the span into the trace store while the collector never answers', async () => {
    const clock = createFakeClock(START_MS);
    const { store } = openStore(clock);
    const collector = holdingCollector();
    const telemetry = createTelemetry({ serviceName: 'momonga-test', serviceVersion: '9.9.9', clock, store, exporters: [collector.exporter], batch: QUIET_BATCH });
    registerCleanup(() => {
      void telemetry.shutdown();
    });
    startAgentSpan(telemetry.tracer, { agentName: 'momonga', agentId: 'agent-1', conversationId: 'conv-1', runId: RUN_ID }).end(clock.now());
    const settled = await Promise.race([telemetry.flushLocal().then(() => 'flushed' as const), new Promise<'held'>((resolve) => setImmediate(() => setImmediate(() => resolve('held'))))]);
    expect(settled).toBe('flushed');
    expect(store.spansForRun(RUN_ID)).toHaveLength(1);
  });
});
