import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach } from 'vitest';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace';
import type { SpanExporter } from '@opentelemetry/sdk-trace';
import { GENAI_CONTENT_SEMCONV, createTelemetry, openTraceStore } from '@momonga/observability';
import type { Telemetry, TraceStore } from '@momonga/observability';
import { createFakeClock } from '@momonga/testkit';
import type { FakeClock } from '@momonga/testkit';

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-'));
  fs.chmodSync(dir, mode);
  registerCleanup(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

export const openStore = (clock: FakeClock): { store: TraceStore; file: string } => {
  const file = path.join(makeDir(), 'traces.db');
  const store = openTraceStore({ path: file, clock });
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
