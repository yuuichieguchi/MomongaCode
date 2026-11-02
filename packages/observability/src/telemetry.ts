import { ROOT_CONTEXT, defaultTextMapGetter, defaultTextMapSetter } from '@opentelemetry/api';
import type { Context, Span } from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BatchSpanProcessor, TracerProvider } from '@opentelemetry/sdk-trace';
import type { SpanExporter } from '@opentelemetry/sdk-trace';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import type { Clock } from '@momonga/foundation';
import { createBodyQueue } from './body-queue.ts';
import { createClockedTracer } from './clocked-tracer.ts';
import type { ClockedTracer } from './clocked-tracer.ts';
import { reportError } from './errors.ts';
import { GENAI_SEMCONV } from './semconv.ts';
import { createTraceStoreExporter } from './trace-exporter.ts';
import type { BodyKind, TraceStore } from './trace-store.ts';

const W3C_PROPAGATOR = new W3CTraceContextPropagator();

const INSTRUMENTATION_SCOPE_NAME = '@momonga/observability';
const DEFAULT_MAX_QUEUED_BODIES = 2048;
const DEFAULT_MAX_QUEUED_BYTES = 16 * 1024 * 1024;

const assertPositiveSafeInteger = (name: string, value: number): void => {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`createTelemetry: ${name} must be a positive safe integer, got ${value}`);
  }
};

export type BatchOptions = {
  maxQueueSize?: number;
  scheduledDelayMs?: number;
  maxExportBatchSize?: number;
  exportTimeoutMs?: number;
};

export type BodyCaptureOptions = {
  enabled: boolean;
  retentionMs: number;
  maxQueuedBodies?: number;
  maxQueuedBytes?: number;
};

export type TelemetryOptions = {
  serviceName: string;
  serviceVersion: string;
  clock: Clock;
  store?: TraceStore;
  exporters?: readonly SpanExporter[];
  batch?: BatchOptions;
  bodies?: BodyCaptureOptions;
  captureMessageContent?: boolean;
};

export type CapturedBody = { kind: BodyKind; content: string };

export type TracePropagation = {
  inject(context: Context): Record<string, string>;
  extract(headers: Readonly<Record<string, string | string[] | undefined>>): Context;
};

export type Telemetry = {
  tracer: ClockedTracer;
  captureMessageContent: boolean;
  propagation: TracePropagation;
  recordBody(span: Span, body: CapturedBody): void;
  forceFlush(): Promise<void>;
  shutdown(): Promise<void>;
};

const batchProcessorOptions = (exporter: SpanExporter, batch: BatchOptions) => ({
  exporter,
  ...(batch.maxQueueSize === undefined ? {} : { maxQueueSize: batch.maxQueueSize }),
  ...(batch.scheduledDelayMs === undefined ? {} : { scheduledDelayMillis: batch.scheduledDelayMs }),
  ...(batch.maxExportBatchSize === undefined ? {} : { maxExportBatchSize: batch.maxExportBatchSize }),
  ...(batch.exportTimeoutMs === undefined ? {} : { exportTimeoutMillis: batch.exportTimeoutMs }),
});

export const createTelemetry = (options: TelemetryOptions): Telemetry => {
  const { store, bodies = { enabled: false, retentionMs: 0 } } = options;
  if (bodies.enabled && store === undefined) throw new TypeError('createTelemetry: bodies.enabled requires a store');
  const maxQueuedBodies = bodies.maxQueuedBodies ?? DEFAULT_MAX_QUEUED_BODIES;
  const maxQueuedBytes = bodies.maxQueuedBytes ?? DEFAULT_MAX_QUEUED_BYTES;
  if (bodies.enabled) {
    assertPositiveSafeInteger('bodies.retentionMs', bodies.retentionMs);
    assertPositiveSafeInteger('bodies.maxQueuedBodies', maxQueuedBodies);
    assertPositiveSafeInteger('bodies.maxQueuedBytes', maxQueuedBytes);
  }
  const batch = options.batch ?? {};
  const bodyQueue = bodies.enabled ? createBodyQueue({ maxEntries: maxQueuedBodies, maxBytes: maxQueuedBytes }) : undefined;
  const storeExporter = store === undefined ? undefined : createTraceStoreExporter(store, bodyQueue);
  const exporters = [...(options.exporters ?? []), ...(storeExporter === undefined ? [] : [storeExporter])];

  const provider = new TracerProvider({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: options.serviceName,
      [ATTR_SERVICE_VERSION]: options.serviceVersion,
    }),
    spanProcessors: exporters.map((exporter) => new BatchSpanProcessor(batchProcessorOptions(exporter, batch))),
  });
  const tracer = createClockedTracer(
    provider.getTracer(INSTRUMENTATION_SCOPE_NAME, undefined, { schemaUrl: GENAI_SEMCONV.schemaUrl }),
    options.clock,
  );
  let shutdownPromise: Promise<void> | undefined;

  return {
    tracer,
    captureMessageContent: options.captureMessageContent === true,
    propagation: {
      inject: (context) => {
        const carrier: Record<string, string> = {};
        W3C_PROPAGATOR.inject(context, carrier, defaultTextMapSetter);
        return carrier;
      },
      extract: (headers) => W3C_PROPAGATOR.extract(ROOT_CONTEXT, headers, defaultTextMapGetter),
    },
    recordBody: (span, body) => {
      if (bodyQueue === undefined) return;
      const { traceId, spanId } = span.spanContext();
      const createdAtMs = options.clock.now();
      bodyQueue.push({
        traceId,
        spanId,
        kind: body.kind,
        content: body.content,
        createdAtMs,
        expiresAtMs: createdAtMs + bodies.retentionMs,
      });
    },
    forceFlush: async () => {
      try {
        await provider.forceFlush();
      } catch (error) {
        reportError(error);
      }
      await storeExporter?.forceFlush?.();
    },
    shutdown: () => {
      shutdownPromise ??= (async () => {
        bodyQueue?.close('telemetry is shut down');
        try {
          await provider.shutdown();
        } catch (error) {
          reportError(error);
        }
      })();
      return shutdownPromise;
    },
  };
};

export const traceparentOf = (span: Span): string => {
  const { traceId, spanId, traceFlags } = span.spanContext();
  return `00-${traceId}-${spanId}-${traceFlags.toString(16).padStart(2, '0')}`;
};

export const contextOf = (traceparent: string): Context =>
  W3C_PROPAGATOR.extract(ROOT_CONTEXT, { traceparent }, defaultTextMapGetter);

export const closeTelemetry = async (telemetry: Telemetry, traceStore: TraceStore): Promise<void> => {
  await telemetry.forceFlush();
  await telemetry.shutdown();
  traceStore.close();
};
