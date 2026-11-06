import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import type { AttributeValue, HrTime } from '@opentelemetry/api';
import { ExportResultCode } from '@opentelemetry/core';
import type { ExportResult } from '@opentelemetry/core';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace';
import { MOMONGA_ATTRIBUTES } from './semconv.ts';
import type { BodyQueue } from './body-queue.ts';
import { reportError, toError } from './errors.ts';
import { BODY_KINDS } from './trace-store.ts';
import type { BodyRecord, SpanKindName, SpanRecord, SpanStatusName, TraceStore } from './trace-store.ts';

export type BodyCapture = { queue: BodyQueue; retentionMs: number };

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

const isContentKey = (key: string): boolean => BODY_KINDS.some((kind) => kind === key);

const definedAttributes = (
  attributes: Readonly<Record<string, AttributeValue | undefined>>,
): Record<string, AttributeValue> => {
  const result: Record<string, AttributeValue> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (value !== undefined && !isContentKey(key)) result[key] = value;
  }
  return result;
};

const bodiesOf = (span: ReadableSpan, capture: BodyCapture | undefined): BodyRecord[] => {
  const { traceId, spanId } = span.spanContext();
  const createdAtMs = hrTimeToMs(span.endTime);
  return BODY_KINDS.flatMap((kind) => {
    const content = span.attributes[kind];
    if (content === undefined) return [];
    if (capture === undefined) throw new TypeError(`span ${spanId} carries ${kind} but the store exporter has no body capture`);
    if (typeof content !== 'string') throw new TypeError(`span ${spanId} has a non-string ${kind} attribute`);
    return [{ traceId, spanId, kind, content, createdAtMs, expiresAtMs: createdAtMs + capture.retentionMs }];
  });
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

const validRecords = (spans: readonly ReadableSpan[], capture: BodyCapture | undefined): SpanRecord[] =>
  spans.flatMap((span) => {
    try {
      const record = toRecord(span);
      for (const body of bodiesOf(span, capture)) capture?.queue.push(body);
      return [record];
    } catch (error) {
      reportError(error);
      return [];
    }
  });

export const createTraceStoreExporter = (store: TraceStore, capture?: BodyCapture): SpanExporter => {
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
    return { code: ExportResultCode.SUCCESS };
  };

  const drainRemaining = async (): Promise<void> => {
    persist([], capture?.queue.drain() ?? []);
  };

  return {
    export: (spans, resultCallback) => {
      resultCallback(persist(validRecords(spans, capture), capture?.queue.drain() ?? []));
    },
    forceFlush: drainRemaining,
    shutdown: drainRemaining,
  };
};
