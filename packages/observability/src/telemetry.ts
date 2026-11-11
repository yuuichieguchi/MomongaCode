import { ROOT_CONTEXT, defaultTextMapGetter, defaultTextMapSetter } from '@opentelemetry/api';
import type { Context, Span } from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BatchSpanProcessor, TracerProvider } from '@opentelemetry/sdk-trace';
import type { SpanExporter } from '@opentelemetry/sdk-trace';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import type { Clock } from '@momonga/foundation';
import { DEFAULT_MAX_QUEUED_BODIES, DEFAULT_MAX_QUEUED_BYTES, createBodyQueue } from './body-queue.ts';
import { createClockedTracer } from './clocked-tracer.ts';
import type { ClockedTracer } from './clocked-tracer.ts';
import { reportError } from './errors.ts';
import { GENAI_SEMCONV } from './semconv.ts';
import { createTraceStoreExporter } from './trace-exporter.ts';
import type { BodyCapture } from './trace-exporter.ts';
import type { TraceStore } from './trace-store.ts';

const W3C_PROPAGATOR = new W3CTraceContextPropagator();

const INSTRUMENTATION_SCOPE_NAME = '@momonga/observability';

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

export type ContentQueueOptions = {
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
  captureMessageContent?: boolean;
  contentRetentionMs?: number;
  contentQueue?: ContentQueueOptions;
};

export type TracePropagation = {
  inject(context: Context): Record<string, string>;
  extract(headers: Readonly<Record<string, string | string[] | undefined>>): Context;
};

export type Telemetry = {
  tracer: ClockedTracer;
  captureMessageContent: boolean;
  propagation: TracePropagation;
  forceFlush(): Promise<void>;
  flushLocal(): Promise<void>;
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
  const { store, captureMessageContent = false } = options;
  const capturesIntoStore = store !== undefined && captureMessageContent;
  const maxQueuedBodies = options.contentQueue?.maxQueuedBodies ?? DEFAULT_MAX_QUEUED_BODIES;
  const maxQueuedBytes = options.contentQueue?.maxQueuedBytes ?? DEFAULT_MAX_QUEUED_BYTES;
  let bodyCapture: BodyCapture | undefined;
  if (capturesIntoStore) {
    const { contentRetentionMs } = options;
    if (contentRetentionMs === undefined) throw new TypeError('createTelemetry: captureMessageContent with a store requires contentRetentionMs');
    assertPositiveSafeInteger('contentRetentionMs', contentRetentionMs);
    assertPositiveSafeInteger('contentQueue.maxQueuedBodies', maxQueuedBodies);
    assertPositiveSafeInteger('contentQueue.maxQueuedBytes', maxQueuedBytes);
    bodyCapture = { queue: createBodyQueue({ maxEntries: maxQueuedBodies, maxBytes: maxQueuedBytes }), retentionMs: contentRetentionMs };
  }
  const batch = options.batch ?? {};
  const storeExporter = store === undefined ? undefined : createTraceStoreExporter(store, bodyCapture);
  const remoteProcessors = (options.exporters ?? []).map((exporter) => new BatchSpanProcessor(batchProcessorOptions(exporter, batch)));
  const storeProcessor = storeExporter === undefined ? undefined : new BatchSpanProcessor(batchProcessorOptions(storeExporter, batch));

  const provider = new TracerProvider({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: options.serviceName,
      [ATTR_SERVICE_VERSION]: options.serviceVersion,
    }),
    spanProcessors: [...remoteProcessors, ...(storeProcessor === undefined ? [] : [storeProcessor])],
  });
  const tracer = createClockedTracer(
    provider.getTracer(INSTRUMENTATION_SCOPE_NAME, undefined, { schemaUrl: GENAI_SEMCONV.schemaUrl }),
    options.clock,
  );
  let shutdownPromise: Promise<void> | undefined;

  return {
    tracer,
    captureMessageContent,
    propagation: {
      inject: (context) => {
        const carrier: Record<string, string> = {};
        W3C_PROPAGATOR.inject(context, carrier, defaultTextMapSetter);
        return carrier;
      },
      extract: (headers) => W3C_PROPAGATOR.extract(ROOT_CONTEXT, headers, defaultTextMapGetter),
    },
    forceFlush: async () => {
      try {
        await provider.forceFlush();
      } catch (error) {
        reportError(error);
      }
      await storeExporter?.forceFlush?.();
    },
    flushLocal: async () => {
      await storeProcessor?.forceFlush();
      await storeExporter?.forceFlush?.();
    },
    shutdown: () => {
      shutdownPromise ??= (async () => {
        try {
          await provider.shutdown();
        } catch (error) {
          reportError(error);
        }
        bodyCapture?.queue.close('telemetry is shut down');
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
