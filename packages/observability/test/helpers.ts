import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach } from 'vitest';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace';
import type { SpanExporter } from '@opentelemetry/sdk-trace';
import { GENAI_CONTENT_SEMCONV, buildCostReport, createTelemetry, describeMoney, moneyTallyOf, openTraceStore, priceCall } from '@momonga/observability';
import type { BilledCall, BodyRecord, CallPrice, CostReport, CostedRun, PriceTable, SpanRecord, Telemetry, TraceStore } from '@momonga/observability';
import { billedCallOf, isBilledChat } from '../src/billed-calls.ts';
import { MOMONGA_ATTRIBUTES } from '../src/semconv.ts';
import { createFakeClock, createTempDir } from '@momonga/testkit';
import type { FakeClock } from '@momonga/testkit';
import { BUSY_WAIT_LIMIT_MS } from '@momonga/foundation';

export const START_MS = 1_800_000_000_000;
export const RUN_ID = 'run-0001';
export const SENTINEL = 'SENTINEL-user-secret-7f3a';
export const QUIET_BATCH = { maxQueueSize: 2048, scheduledDelayMs: 60_000, maxExportBatchSize: 512 };

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

export const registerCleanup = (cleanup: () => void | Promise<void>): void => {
  cleanups.push(cleanup);
};

export const makeDir = (mode = 0o700): string => {
  const dir = createTempDir();
  fs.chmodSync(dir, mode);
  registerCleanup(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

export const openStore = (clock: FakeClock): { store: TraceStore; file: string } => {
  const file = path.join(makeDir(), 'traces.db');
  const store = openTraceStore({ busyTimeoutMs: BUSY_WAIT_LIMIT_MS, path: file, clock });
  registerCleanup(() => store.close());
  return { store, file };
};

export type Harness = {
  clock: FakeClock;
  telemetry: Telemetry;
  memory: InMemorySpanExporter;
  store: TraceStore;
  file: string;
};

export const harness = (
  options: { content?: { retentionMs: number; maxQueuedBodies?: number; maxQueuedBytes?: number }; exporters?: SpanExporter[] } = {},
): Harness => {
  const clock = createFakeClock(START_MS);
  const { store, file } = openStore(clock);
  const memory = new InMemorySpanExporter();
  const telemetry = createTelemetry({
    serviceName: 'momonga-test',
    serviceVersion: '9.9.9',
    clock,
    store,
    exporters: [memory, ...(options.exporters ?? [])],
    batch: QUIET_BATCH,
    ...(options.content === undefined
      ? {}
      : {
          captureMessageContent: true,
          contentRetentionMs: options.content.retentionMs,
          contentQueue: {
            ...(options.content.maxQueuedBodies === undefined ? {} : { maxQueuedBodies: options.content.maxQueuedBodies }),
            ...(options.content.maxQueuedBytes === undefined ? {} : { maxQueuedBytes: options.content.maxQueuedBytes }),
          },
        }),
  });
  registerCleanup(() => telemetry.shutdown());
  return { clock, telemetry, memory, store, file };
};

export const dumpAllRows = (file: string): string => {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
    return JSON.stringify(
      tables.map((table) => ({ table: table.name, rows: db.prepare(`SELECT * FROM "${table.name}"`).all() })),
    );
  } finally {
    db.close();
  }
};

export const CONTENT = GENAI_CONTENT_SEMCONV;

export const CONTENT_KEYS = Object.values(GENAI_CONTENT_SEMCONV) as string[];

const EVERY_BODY = Number.MAX_SAFE_INTEGER;

export type BilledCallAtCallTime = BilledCall & { price: CallPrice };

const priceAtCallTime = (span: SpanRecord, call: BilledCall, table: PriceTable): CallPrice => {
  const usageSource = span.attributes[MOMONGA_ATTRIBUTES.usageSource];
  if (usageSource === undefined) return { kind: 'not_recorded' };
  if (usageSource !== 'reported' && usageSource !== 'estimated') throw new TypeError(`chat span ${span.spanId} attribute ${MOMONGA_ATTRIBUTES.usageSource} must be reported or estimated, got ${String(usageSource)}`);
  return priceCall({ provider: call.provider, model: call.model, billing: call.billing, usageSource, usage: call.usage, at: new Date(span.startMs), table });
};

const recordedAtCallTime = (runId: string, spans: readonly SpanRecord[], table: PriceTable): BilledCallAtCallTime[] =>
  spans
    .filter(isBilledChat)
    .toSorted((left, right) => left.startMs - right.startMs || (left.spanId < right.spanId ? -1 : 1))
    .map((span) => {
      const call = billedCallOf(runId, span);
      return { ...call, price: priceAtCallTime(span, call, table) };
    });

export const billedCallsOfRun = (store: TraceStore, runId: string, table: PriceTable): BilledCallAtCallTime[] => recordedAtCallTime(runId, store.spansForRun(runId), table);

export const costReportOfSpans = (store: TraceStore, runs: readonly CostedRun[], options: { table: PriceTable; includeRunless?: boolean }): CostReport =>
  buildCostReport(
    [...runs.flatMap((run) => billedCallsOfRun(store, run.runId, options.table)), ...(options.includeRunless === true ? recordedAtCallTime('', store.spansWithoutRun(), options.table) : [])],
    runs,
    options.includeRunless === undefined ? {} : { includeRunless: options.includeRunless },
  );

export const moneyLine = (outcomes: readonly CallPrice[]): string => describeMoney(moneyTallyOf(outcomes));

export const bodiesOfSpan = (store: TraceStore, spanId: string, runId: string = RUN_ID): BodyRecord[] =>
  store
    .bodiesOfRunAfter(runId, 0, EVERY_BODY)
    .map((stored) => stored.body)
    .filter((body) => body.spanId === spanId);
