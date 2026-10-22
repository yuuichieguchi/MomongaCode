import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import type { AttributeValue, HrTime } from '@opentelemetry/api';
import { ExportResultCode } from '@opentelemetry/core';
import type { ExportResult } from '@opentelemetry/core';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace';
import { MOMONGA_ATTRIBUTES } from './semconv.ts';
import type { BodyQueue } from './body-queue.ts';
import { reportError, toError } from './errors.ts';
import type { BodyRecord, SpanKindName, SpanRecord, SpanStatusName, TraceStore } from './trace-store.ts';

const KIND_NAMES: Record<SpanKind, SpanKindName> = {
  [SpanKind.INTERNAL]: 'INTERNAL',
  [SpanKind.SERVER]: 'SERVER',
  [SpanKind.CLIENT]: 'CLIENT',
  [SpanKind.PRODUCER]: 'PRODUCER',
  [SpanKind.CONSUMER]: 'CONSUMER',
};

const STATUS_NAMES: Record<SpanStatusCode, SpanStatusName> = {
  [SpanStatusCode.UNSET]: 'UNSET',
  [SpanStatusCode.OK]: 'OK',
  [SpanStatusCode.ERROR]: 'ERROR',
};

const NANOS_PER_MILLI = 1_000_000;
const MILLIS_PER_SECOND = 1000;

const hrTimeToMs = ([seconds, nanos]: HrTime): number =>
  seconds * MILLIS_PER_SECOND + Math.floor(nanos / NANOS_PER_MILLI);

const definedAttributes = (
  attributes: Readonly<Record<string, AttributeValue | undefined>>,
): Record<string, AttributeValue> => {
  const result: Record<string, AttributeValue> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
};

const runIdOf = (span: ReadableSpan): string | null => {
  const value = span.attributes[MOMONGA_ATTRIBUTES.runId];
  if (value === undefined) return null;
  if (typeof value !== 'string') {
    throw new TypeError(`span ${span.spanContext().spanId} has a non-string ${MOMONGA_ATTRIBUTES.runId} attribute`);
  }
  return value;
};

const toRecord = (span: ReadableSpan): SpanRecord => {
  const { traceId, spanId } = span.spanContext();
  return {
    traceId,
    spanId,
    parentSpanId: span.parentSpanContext?.spanId ?? null,
    name: span.name,
    kind: KIND_NAMES[span.kind],
    startMs: hrTimeToMs(span.startTime),
    endMs: hrTimeToMs(span.endTime),
    status: STATUS_NAMES[span.status.code],
    attributes: definedAttributes(span.attributes),
    events: span.events.map((event) => ({
      name: event.name,
      timeMs: hrTimeToMs(event.time),
      attributes: definedAttributes(event.attributes ?? {}),
    })),
    runId: runIdOf(span),
  };
};

const validRecords = (spans: readonly ReadableSpan[]): SpanRecord[] =>
  spans.flatMap((span) => {
    try {
      return [toRecord(span)];
    } catch (error) {
      reportError(error);
      return [];
    }
  });

export const createTraceStoreExporter = (store: TraceStore, bodies?: BodyQueue): SpanExporter => {
  const persist = (records: SpanRecord[], pendingBodies: BodyRecord[]): ExportResult => {
    if (records.length === 0 && pendingBodies.length === 0) return { code: ExportResultCode.SUCCESS };
    try {
      store.writeSpans(records, pendingBodies);
    } catch (error) {
      if (pendingBodies.length > 0) {
        reportError(new Error(`dropped ${pendingBodies.length} captured bodies after a failed store write`, { cause: error }));
      }
      return { code: ExportResultCode.FAILED, error: toError(error) };
    }
    if (pendingBodies.length > 0) {
      try {
        store.purgeExpired();
      } catch (error) {
        reportError(error);
      }
    }
    return { code: ExportResultCode.SUCCESS };
  };

  const drainRemaining = async (): Promise<void> => {
    persist([], bodies?.drain() ?? []);
  };

  return {
    export: (spans, resultCallback) => {
      resultCallback(persist(validRecords(spans), bodies?.drain() ?? []));
    },
    forceFlush: drainRemaining,
    shutdown: drainRemaining,
  };
};
